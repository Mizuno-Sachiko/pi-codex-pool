/**
 * Multi-Subscription extension for pi.
 *
 * Register additional ChatGPT Plus/Pro accounts through OpenAI Codex OAuth.
 * Each extra account gets its own provider name, /login entry, and cloned models.
 *
 * Features:
 *   - /subs: manage subscriptions (add, remove, login, logout, status)
 *   - /pool: define provider pools with auto-rotation on rate limit errors
 *   - Project-level pool config: .pi/multi-pass.json overrides global pools
 *   - MULTI_SUB env var for scripting
 *
 * Each enabled pool publishes models under its own provider name.
 * Pool requests choose and reserve accounts across Pi processes; physical
 * subscription models remain pinned to their selected account.
 *
 * Config files:
 *   Global:  ~/.pi/agent/multi-pass.json  (subscriptions + default pools)
 *   Project: .pi/multi-pass.json          (pool overrides + subscription filtering)
 *
 * Project-level config can:
 *   - Define project-specific pools (override global pools)
 *   - Restrict which subscriptions are usable via "allowedSubs"
 *   - Omit pools to inherit global pools
 *
 * Supported provider:
 *   - openai-codex (ChatGPT Plus/Pro Codex)
 */

import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { spawn } from "node:child_process";
import { createRequire, findPackageJSON } from "node:module";
import { isAbsolute, join } from "node:path";
import {
	accountProviders,
	addSubscription,
	buildEffectiveConfig,
	isCodexProviderName,
	mergeConfigs,
	normalizeMultiPassConfig,
	normalizeProjectConfig,
	parseEnvConfig,
	pruneRemovedPoolReferences,
	readConfig,
	removeSubscription,
	renamePoolReferences,
	replaceNamed,
	requireNamed,
	subProviderName,
	updateConfig,
	type ChainConfig,
	type ChainEntryConfig,
	type EffectiveConfig,
	type MemberSchedule,
	type MultiPassConfig,
	type PoolConfig,
	type PoolStrategy,
	type PresetConfig,
	type PresetEntry,
	type ProjectConfig,
	type SubEntry,
} from "../src/config.mts";
import { getScheduledMemberOrder, getScheduledMemberState, parseScheduleWindowInput } from "../src/schedule.mts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	BorderedLoader,
	DynamicBorder,
	getAgentDir,
	getPackageDir,
	keyHint,
	readStoredCredential,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { setTimeout as wait } from "node:timers/promises";
import { accountKey, record as getRecord } from "../src/limits.mts";
import { buildPoolModels, configuredHeaderNames, selectAccountModel } from "../src/models.mts";
import {
	classifyCodexQuotaKind,
	exhaustedResetAt,
	getCodexWindowRemaining,
	parseCodexUsageSnapshot,
} from "../src/quota.mts";
import { CodexConnections, PoolRouter, type RoutingStatus } from "../src/pool-router.mts";
import { selectCustomMember } from "../src/selector.mts";
import {
	SharedPoolState,
	activeRequests,
	unavailableUntil,
	type Member,
	type StoredQuota,
} from "../src/shared-state.mts";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createOAuthInteraction } from "../src/oauth-compat.mts";
import { Container, Key, SelectList, Text, matchesKey, type SelectItem } from "@earendil-works/pi-tui";

function getAuthStorage(ctx: { modelRegistry: { getProviderAuthStatus(provider: string): { configured: boolean } } }): {
	hasAuth(provider: string): boolean;
	get(provider: string): Record<string, unknown> | undefined;
	logout(provider: string): Promise<void>;
} {
	return {
		hasAuth: (provider) => ctx.modelRegistry.getProviderAuthStatus(provider).configured,
		get: (provider) => readStoredCredential(provider) as Record<string, unknown> | undefined,
		logout: (provider) => accountRuntime.logout(provider),
	};
}

/** Report model-switch errors and let interactive callers keep their current selection. */
async function safeSetModel(pi: ExtensionAPI, model: Model<Api>): Promise<boolean> {
	try {
		return await pi.setModel(model);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`multi-pass: model switch to ${model.provider}/${model.id} failed: ${detail}`);
		return false;
	}
}

// ==========================================================================
// Provider templates
// ==========================================================================

const openaiCodexProvider = builtinProviders().find(({ id }) => id === "openai-codex");
if (!openaiCodexProvider?.auth.oauth) {
	throw new Error("pi-codex-pool: the installed pi-ai OpenAI Codex provider has no OAuth flow");
}
const openaiCodexOAuth = openaiCodexProvider.auth.oauth;
const codexTransport = openaiCodexProvider;
const aiPackage = findPackageJSON("@earendil-works/pi-ai", join(getPackageDir(), "package.json"));
if (!aiPackage) throw new Error("pi-codex-pool: host pi-ai package not found");
// Resolve the host copy so connection cleanup shares Pi's live socket cache.
const { closeOpenAICodexWebSocketSessions } = createRequire(aiPackage)(
	"./dist/api/openai-codex-responses.js",
) as typeof import("@earendil-works/pi-ai/api/openai-codex-responses");

// Use Pi's own file lock so login and refresh cannot race a conditional removal.
const { FileAuthStorageBackend } = createRequire(join(getPackageDir(), "package.json"))(
	"./dist/core/auth-storage.js",
) as {
	FileAuthStorageBackend: new () => {
		withLockAsync<T>(change: (source: string | undefined) => Promise<{ result: T; next?: string }>): Promise<T>;
	};
};

const codexConnections = new CodexConnections(closeOpenAICodexWebSocketSessions);
let accountRuntime: ModelRuntime;
let refreshingAccounts: Promise<void> | undefined;

function refreshAccountModels(): Promise<void> {
	if (!refreshingAccounts) {
		refreshingAccounts = accountRuntime
			.refresh({ allowNetwork: false })
			.then(() => undefined)
			.finally(() => {
				refreshingAccounts = undefined;
			});
	}
	return refreshingAccounts;
}

function getCodexModels(): Model<Api>[] {
	return [...accountRuntime.getModels("openai-codex")];
}

function poolProviderNameError(name: string): string | undefined {
	if (
		!name.trim() ||
		/[/:\\]/u.test(name) ||
		[...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
	)
		return "Pool names cannot contain slashes, colons, or control characters.";
	if (
		isCodexProviderName(name) ||
		builtinProviders().some((provider) => provider.id === name) ||
		(accountRuntime.getProvider(name) && !loadGlobalConfig().pools.some((pool) => pool.name === name))
	) {
		return `Provider name "${name}" is already in use.`;
	}
	return undefined;
}

const PROVIDER_TEMPLATES: Record<string, { displayName: string }> = {
	"openai-codex": { displayName: "ChatGPT Plus/Pro (Codex)" },
};

const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_TEMPLATES);

// ==========================================================================
// Built-in quota checking
// ==========================================================================

const DEFAULT_CODEX_USAGE_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const OPENAI_PROFILE_CLAIM = "https://api.openai.com/profile";

type QuotaStatusKind = "ready" | "watch" | "low" | "blocked" | "error" | "missing-auth";

interface AuthStorageEntry {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	accountId?: string;
	projectId?: string;
	[key: string]: unknown;
}

interface QuotaAccount {
	providerName: string;
	baseProvider: string;
	displayName: string;
	auth?: AuthStorageEntry;
}

interface QuotaCheckResult {
	account: QuotaAccount;
	kind: QuotaStatusKind;
	summary: string;
	details: string[];
	score: number;
	/** Latest reset timestamp (epoch seconds) among exhausted usage windows. */
	resetAt?: number;
	checkedAt?: number;
}

interface ProviderQuotaChecker {
	baseProvider: string;
	check(account: QuotaAccount, signal?: AbortSignal): Promise<QuotaCheckResult>;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
	const parts = token.split(".");
	if (parts.length < 2) return {};
	try {
		return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function getCodexTokenMetadata(accessToken: string): {
	accountId?: string;
	planType?: string;
	email?: string;
} {
	const payload = decodeJwtPayload(accessToken);
	const auth = getRecord(payload[OPENAI_AUTH_CLAIM]);
	const profile = getRecord(payload[OPENAI_PROFILE_CLAIM]);
	const accountId = typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
	const planType = typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined;
	const email = typeof profile?.email === "string" ? profile.email : undefined;
	return { accountId, planType, email };
}

function formatResetShort(resetAt?: number): string {
	if (!resetAt) return "--";
	const diffMs = resetAt * 1000 - Date.now();
	if (diffMs <= 0) return "now";
	const totalMinutes = Math.round(diffMs / 60000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `~${days}d`;
	if (hours > 0) return `~${hours}h`;
	return `~${minutes}m`;
}

function formatResetLong(resetAt?: number): string {
	if (!resetAt) return "unknown";
	const diffMs = resetAt * 1000 - Date.now();
	if (diffMs <= 0) return "now";
	const totalMinutes = Math.round(diffMs / 60000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `in ${days}d ${hours}h`;
	if (hours > 0) return `in ${hours}h ${minutes}m`;
	return `in ${minutes}m`;
}

function formatRemainingPercent(value: number | undefined): string {
	if (value === undefined) return "--";
	return `${Math.round(value)}%`;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

async function readResponseError(response: Response): Promise<string> {
	const raw = await response.text();
	if (response.status === 401) {
		return "Unauthorized - log in again";
	}
	if (!raw) {
		return `HTTP ${response.status}`;
	}
	try {
		const parsed = JSON.parse(raw) as {
			error?: { message?: string };
			message?: string;
		};
		const message = parsed.error?.message || parsed.message;
		if (message) return `HTTP ${response.status}: ${message}`;
	} catch {
		// ignore JSON parse errors and fall back to raw text
	}
	return `HTTP ${response.status}: ${raw}`;
}

function formatQuotaKind(kind: QuotaStatusKind): string {
	switch (kind) {
		case "ready":
			return "ready";
		case "watch":
			return "watch";
		case "low":
			return "low";
		case "blocked":
			return "blocked";
		case "missing-auth":
			return "not logged in";
		default:
			return "error";
	}
}

function compareQuotaResults(left: QuotaCheckResult, right: QuotaCheckResult): number {
	const rank = (kind: QuotaStatusKind): number => {
		switch (kind) {
			case "ready":
				return 0;
			case "watch":
				return 1;
			case "low":
				return 2;
			case "blocked":
				return 3;
			case "error":
				return 4;
			case "missing-auth":
				return 5;
		}
	};
	return (
		rank(left.kind) - rank(right.kind) ||
		right.score - left.score ||
		left.account.displayName.localeCompare(right.account.displayName)
	);
}

function getQuotaStatusGlyph(kind: QuotaStatusKind): string {
	switch (kind) {
		case "ready":
			return "✓";
		case "watch":
			return "◔";
		case "low":
			return "!";
		case "blocked":
			return "✕";
		case "missing-auth":
			return "○";
		default:
			return "?";
	}
}

function formatQuotaOverview(results: QuotaCheckResult[]): string {
	const counts = {
		ready: 0,
		watch: 0,
		low: 0,
		blocked: 0,
		error: 0,
		missingAuth: 0,
	};

	for (const result of results) {
		switch (result.kind) {
			case "ready":
				counts.ready++;
				break;
			case "watch":
				counts.watch++;
				break;
			case "low":
				counts.low++;
				break;
			case "blocked":
				counts.blocked++;
				break;
			case "missing-auth":
				counts.missingAuth++;
				break;
			default:
				counts.error++;
		}
	}

	const parts = [`${results.length} ${results.length === 1 ? "account" : "accounts"}`];
	if (counts.ready > 0) parts.push(`${counts.ready} ready`);
	if (counts.watch > 0) parts.push(`${counts.watch} watch`);
	if (counts.low > 0) parts.push(`${counts.low} low`);
	if (counts.blocked > 0) parts.push(`${counts.blocked} blocked`);
	if (counts.error > 0) parts.push(`${counts.error} error`);
	if (counts.missingAuth > 0) parts.push(`${counts.missingAuth} not logged in`);

	const best = results[0];
	if (best) {
		parts.push(`best now: ${best.account.displayName}`);
	}

	return parts.join(" • ");
}

function formatQuotaCurrentHint(
	results: QuotaCheckResult[],
	currentProviderName: string | undefined,
): string | undefined {
	if (!currentProviderName) return undefined;

	const current = results.find((result) => result.account.providerName === currentProviderName);
	if (!current) return undefined;

	let hint = `Current: ${current.account.displayName} is ${formatQuotaKind(current.kind)}`;
	const best = results[0];
	if (best && best.account.providerName !== current.account.providerName) {
		hint += ` • best available: ${best.account.displayName}`;
	}
	if (current.kind !== "ready") {
		hint += " • snapshot only: auto-switch happens after a runtime rate-limit error";
	}
	return hint;
}

function buildQuotaSelectItems(results: QuotaCheckResult[], currentProviderName: string | undefined): SelectItem[] {
	const bestProviderName = results[0]?.account.providerName;
	return results.map((result) => {
		const badges: string[] = [];
		if (result.account.providerName === currentProviderName) badges.push("current");
		if (result.account.providerName === bestProviderName) badges.push("best now");
		const badgeSuffix = badges.length > 0 ? ` • ${badges.join(" • ")}` : "";

		return {
			value: result.account.providerName,
			label: `${getQuotaStatusGlyph(result.kind)} ${result.account.displayName}`,
			description: `${result.summary}${badgeSuffix}`,
		};
	});
}

function getWrappedSelectIndex(items: SelectItem[], value: string | undefined): number {
	if (!value) return 0;
	const index = items.findIndex((item) => item.value === value);
	return index >= 0 ? index : 0;
}

async function showWrappedSelect(
	ctx: ExtensionCommandContext,
	options: {
		title: string;
		items: SelectItem[];
		subtitle?: string;
		initialValue?: string;
		confirmHint?: string;
		cancelHint?: string;
	},
): Promise<string | undefined> {
	if (options.items.length === 0) return undefined;

	if (ctx.mode !== "tui") {
		const renderedItems = options.items.map((item) =>
			item.description ? `${item.label} — ${item.description}` : item.label,
		);
		const selected = await ctx.ui.select(options.title, renderedItems);
		if (!selected) return undefined;
		const index = renderedItems.indexOf(selected);
		return index >= 0 ? options.items[index]?.value : undefined;
	}

	const confirmHint = options.confirmHint || "select";
	const cancelHint = options.cancelHint || "close";

	const selectedValue = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		const footer = [keyHint("tui.select.confirm", confirmHint), keyHint("tui.select.cancel", cancelHint)].join(" • ");

		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(options.title))));
		if (options.subtitle) {
			container.addChild(new Text(theme.fg("dim", options.subtitle)));
		}

		const selectList = new SelectList(options.items, Math.min(options.items.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.setSelectedIndex(getWrappedSelectIndex(options.items, options.initialValue));
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", footer)));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				const current = selectList.getSelectedItem();
				const currentIndex = current ? options.items.findIndex((item) => item.value === current.value) : 0;

				if (matchesKey(data, Key.up) && options.items.length > 1 && currentIndex === 0) {
					selectList.setSelectedIndex(options.items.length - 1);
					tui.requestRender();
					return;
				}

				if (matchesKey(data, Key.down) && options.items.length > 1 && currentIndex === options.items.length - 1) {
					selectList.setSelectedIndex(0);
					tui.requestRender();
					return;
				}

				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	return selectedValue ?? undefined;
}

async function runQuotaChecks(
	accounts: QuotaAccount[],
	signal?: AbortSignal,
	reason: "manual" | "limit" = "manual",
): Promise<QuotaCheckResult[]> {
	const shared = getSharedPoolState();
	const results = await Promise.all(
		accounts.map(async (account): Promise<QuotaCheckResult | undefined> => {
			try {
				// Resolve once: the queried identity must also own the shared refresh record.
				if (account.auth?.type === "oauth") {
					const timeout = AbortSignal.timeout(20_000);
					const resolved = await accountRuntime.getAuth(account.providerName, {
						signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
					});
					if (!resolved?.auth.apiKey) throw new Error("Account authentication is unavailable; use /subs login");
					account = { ...account, auth: { type: "oauth", access: resolved.auth.apiKey } };
				}
				const key = accountKey(account.providerName, account.auth?.access);
				let action = shared.beginRefresh(key, reason === "manual" ? 10_000 : 60_000);
				// Another window owns this lookup; wait for its result instead of duplicating it.
				while (action === "pending") {
					await wait(200, undefined, { signal });
					action = shared.beginRefresh(key, reason === "manual" ? 10_000 : 60_000);
				}
				if (action === "cached") {
					const quota = shared.snapshot().accounts[key]?.quota;
					return quota
						? { account, ...quota }
						: {
								account,
								kind: "error" as const,
								score: 0,
								summary: "No completed quota check; use /subs limits",
								details: ["No completed quota check; use /subs limits"],
							};
				}
				const checkedAt = action.startedAt;
				let quota: StoredQuota | undefined;
				try {
					const checker = PROVIDER_QUOTA_CHECKERS.find((candidate) => candidate.baseProvider === account.baseProvider);
					if (!checker) return undefined;
					const result = await checker.check(account, signal);
					quota = {
						checkedAt,
						kind: result.kind,
						summary: result.summary,
						details: result.details.filter((detail) => !detail.startsWith("email:")),
						score: result.score,
						resetAt: result.resetAt,
					};
					// Credential-bearing account objects remain in this process, never in shared storage.
					return { ...result, checkedAt };
				} finally {
					shared.finishRefresh(key, action.id, quota);
				}
			} catch (error) {
				signal?.throwIfAborted();
				const message = error instanceof Error ? error.message : String(error);
				return { account, kind: "error", score: 0, summary: message, details: [message] };
			}
		}),
	);
	return results.filter((result): result is QuotaCheckResult => Boolean(result)).sort(compareQuotaResults);
}

async function loadQuotaResults(
	ctx: ExtensionCommandContext,
	accounts: QuotaAccount[],
): Promise<QuotaCheckResult[] | null> {
	if (ctx.mode !== "tui") {
		return runQuotaChecks(accounts);
	}

	const result = await ctx.ui.custom<QuotaCheckResult[] | Error | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(
			tui,
			theme,
			`Checking limits across ${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}...`,
		);
		loader.onAbort = () => done(null);

		runQuotaChecks(accounts, loader.signal)
			.then(done)
			.catch((error) => {
				if (loader.signal.aborted) {
					done(null);
					return;
				}
				done(error instanceof Error ? error : new Error(String(error)));
			});

		return loader;
	});
	if (result instanceof Error) throw result;
	return result;
}

async function selectQuotaResult(
	ctx: ExtensionCommandContext,
	results: QuotaCheckResult[],
	preferredProviderName?: string,
): Promise<QuotaCheckResult | undefined> {
	const currentProviderName = preferredProviderName || ctx.model?.provider;
	const selectedProviderName = await showWrappedSelect(ctx, {
		title: "Subscription Limits",
		subtitle: [
			"Select an account to inspect its full quota windows.",
			formatQuotaOverview(results),
			formatQuotaCurrentHint(results, currentProviderName),
		]
			.filter(Boolean)
			.join("\n"),
		items: buildQuotaSelectItems(results, currentProviderName),
		initialValue: currentProviderName,
		confirmHint: "inspect",
		cancelHint: "close",
	});
	if (!selectedProviderName) return undefined;
	return results.find((result) => result.account.providerName === selectedProviderName);
}

function collectQuotaAccounts(ctx: ExtensionContext): QuotaAccount[] {
	return collectQuotaAccountsForProject(ctx.cwd);
}

function collectQuotaAccountsForProject(cwd: string): QuotaAccount[] {
	const config = loadEffectiveConfig(cwd);
	return accountProviders(config, readStoredCredential("openai-codex")?.type === "oauth").map((providerName) => ({
		providerName,
		baseProvider: "openai-codex",
		displayName: getProviderDisplayName(providerName, config.subscriptions),
		auth: readStoredCredential(providerName) as AuthStorageEntry | undefined,
	}));
}

const codexQuotaChecker: ProviderQuotaChecker = {
	baseProvider: "openai-codex",
	async check(account: QuotaAccount, signal?: AbortSignal): Promise<QuotaCheckResult> {
		const auth = account.auth;
		if (auth?.type !== "oauth" || typeof auth.access !== "string" || auth.access.length === 0) {
			return {
				account,
				kind: "missing-auth",
				summary: "not logged in",
				details: [
					`account: ${account.displayName}`,
					`provider: ${account.providerName}`,
					"status: not logged in",
					"login: use /subs login or /login to authenticate this account",
				],
				score: 0,
			};
		}

		const tokenMetadata = getCodexTokenMetadata(auth.access);
		const accountId =
			typeof auth.accountId === "string" && auth.accountId.length > 0 ? auth.accountId : tokenMetadata.accountId;
		const baseUrl = (process.env.CHATGPT_BASE_URL || DEFAULT_CODEX_USAGE_BASE_URL).replace(/\/+$/, "");
		const headers = new Headers({
			Authorization: `Bearer ${auth.access}`,
			Accept: "application/json",
			"User-Agent": "pi-codex-pool",
		});
		if (accountId) {
			headers.set("chatgpt-account-id", accountId);
		}

		try {
			const timeout = AbortSignal.timeout(20_000);
			const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
			const response = await fetch(`${baseUrl}/wham/usage`, {
				method: "GET",
				headers,
				signal: requestSignal,
			});
			if (!response.ok) {
				const error = await readResponseError(response);
				return {
					account,
					kind: "error",
					summary: error,
					details: [
						`account: ${account.displayName}`,
						`provider: ${account.providerName}`,
						`status: error`,
						`details: ${error}`,
					],
					score: 0,
				};
			}

			const snapshot = parseCodexUsageSnapshot(await response.json());
			if (!snapshot.email && tokenMetadata.email) snapshot.email = tokenMetadata.email;
			if ((!snapshot.planType || snapshot.planType === "unknown") && tokenMetadata.planType) {
				snapshot.planType = tokenMetadata.planType;
			}
			const fiveHourLeft = getCodexWindowRemaining(snapshot.fiveHour);
			const weeklyLeft = getCodexWindowRemaining(snapshot.weekly);
			const nextResetAt = exhaustedResetAt(snapshot);
			const classification = classifyCodexQuotaKind(snapshot);
			const summary = [
				snapshot.planType !== "unknown" ? snapshot.planType : "plan unknown",
				`5h ${formatRemainingPercent(fiveHourLeft)} (${formatResetShort(snapshot.fiveHour?.resetAt)})`,
				`7d ${formatRemainingPercent(weeklyLeft)} (${formatResetShort(snapshot.weekly?.resetAt)})`,
				formatQuotaKind(classification.kind),
			].join(" | ");
			const details = [
				`account: ${account.displayName}`,
				`provider: ${account.providerName}`,
				`status: ${formatQuotaKind(classification.kind)}`,
				`plan: ${snapshot.planType}`,
			];
			if (snapshot.email) {
				details.push(`email: ${snapshot.email}`);
			}
			details.push(
				`5-hour window: ${formatRemainingPercent(fiveHourLeft)} left, resets ${formatResetLong(snapshot.fiveHour?.resetAt)}`,
				`7-day window: ${formatRemainingPercent(weeklyLeft)} left, resets ${formatResetLong(snapshot.weekly?.resetAt)}`,
				`endpoint: ${baseUrl}/wham/usage`,
			);
			return {
				account,
				kind: classification.kind,
				summary,
				details,
				score: classification.score,
				resetAt: nextResetAt,
			};
		} catch (error: unknown) {
			if (signal?.aborted || isAbortError(error)) throw error;
			const message = error instanceof Error ? error.message : String(error);
			return {
				account,
				kind: "error",
				summary: message,
				details: [
					`account: ${account.displayName}`,
					`provider: ${account.providerName}`,
					"status: error",
					`details: ${message}`,
				],
				score: 0,
			};
		}
	},
};

const PROVIDER_QUOTA_CHECKERS: ProviderQuotaChecker[] = [codexQuotaChecker];

async function showQuotaDetails(ctx: ExtensionCommandContext, result: QuotaCheckResult): Promise<void> {
	await showWrappedSelect(ctx, {
		title: `Limit Details: ${result.account.displayName}`,
		subtitle: "Press Enter or Escape to go back to the limits list.",
		items: result.details.map((detail, index) => ({ value: `${index}:${detail}`, label: detail })),
		confirmHint: "back",
		cancelHint: "back",
	});
}

async function handleSubsLimits(ctx: ExtensionCommandContext): Promise<void> {
	const allowedProviderNames = loadEffectiveConfig(ctx.cwd).allowedProviderNames;
	const accounts = collectQuotaAccounts(ctx);
	if (accounts.length === 0) {
		const suffix =
			allowedProviderNames && allowedProviderNames.length > 0
				? ` for this project restriction (${allowedProviderNames.join(", ")})`
				: "";
		ctx.ui.notify(
			`No supported subscription limits are available yet${suffix}. Login to a supported provider first.`,
			"info",
		);
		return;
	}

	const results = await loadQuotaResults(ctx, accounts);
	if (!results) {
		ctx.ui.notify("Cancelled subscription limit check.", "info");
		return;
	}
	if (results.length === 0) {
		ctx.ui.notify("No supported quota checks matched the configured subscriptions.", "info");
		return;
	}

	let preferredProviderName = ctx.model?.provider;
	while (true) {
		const selected = await selectQuotaResult(ctx, results, preferredProviderName);
		if (!selected) return;
		preferredProviderName = selected.account.providerName;
		await showQuotaDetails(ctx, selected);
	}
}

// ==========================================================================
// Config persistence (~/.pi/agent/multi-pass.json)
// ==========================================================================

function globalConfigPath(): string {
	return join(getAgentDir(), "multi-pass.json");
}

function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "multi-pass.json");
}

// ==========================================================================
// Shared account state (~/.pi/agent/multi-pass.sqlite)
// ==========================================================================

let sharedPoolState: SharedPoolState | undefined;
let sharedSessions = 0;

function getSharedPoolState(): SharedPoolState {
	sharedPoolState ??= new SharedPoolState(join(getAgentDir(), "multi-pass.sqlite"));
	return sharedPoolState;
}

function getMember(provider: string): Member {
	const auth = readStoredCredential(provider) as AuthStorageEntry | undefined;
	return { provider, key: accountKey(provider, auth?.access) };
}

function loadGlobalConfig(): MultiPassConfig {
	return readConfig(globalConfigPath(), normalizeMultiPassConfig) ?? normalizeMultiPassConfig({});
}

function loadProjectConfig(cwd: string): ProjectConfig | undefined {
	return readConfig(projectConfigPath(cwd), normalizeProjectConfig);
}

function loadEffectiveConfig(cwd: string): EffectiveConfig {
	const project = loadProjectConfig(cwd);
	return {
		...buildEffectiveConfig(loadGlobalConfig(), project, parseEnvConfig()),
		projectConfigPath: project ? projectConfigPath(cwd) : undefined,
	};
}

function updateGlobalConfig<T>(change: (config: MultiPassConfig) => T): T {
	return updateConfig(getSharedPoolState(), globalConfigPath(), normalizeMultiPassConfig, change);
}

function updateProjectConfig<T>(cwd: string, change: (config: ProjectConfig) => T): T {
	return updateConfig(getSharedPoolState(), projectConfigPath(cwd), normalizeProjectConfig, change);
}

function getProviderDisplayName(providerName: string, subscriptions: SubEntry[]): string {
	const subEntry = subscriptions.find((entry) => subProviderName(entry) === providerName);
	if (subEntry) {
		return subDisplayName(subEntry);
	}
	return PROVIDER_TEMPLATES[providerName]?.displayName || providerName;
}

function getProjectScopedProviderNames(
	ctx: ExtensionContext | ExtensionCommandContext,
	effective: EffectiveConfig,
): string[] {
	return accountProviders(effective, getAuthStorage(ctx).hasAuth("openai-codex"));
}

function findSelectableModelForProvider(
	ctx: ExtensionContext | ExtensionCommandContext,
	providerName: string,
	preferredModelId?: string,
): Model<Api> | undefined {
	if (!getAuthStorage(ctx).hasAuth(providerName)) {
		return undefined;
	}
	return selectAccountModel(
		ctx.modelRegistry.getAll().filter((model) => model.provider === providerName),
		preferredModelId,
	);
}

function formatAllowedProviderSummary(effective: EffectiveConfig): string | undefined {
	return effective.allowedProviderNames && effective.allowedProviderNames.length > 0
		? effective.allowedProviderNames.join(", ")
		: undefined;
}

// ==========================================================================
// Provider name helpers
// ==========================================================================

function subDisplayName(entry: SubEntry): string {
	const template = PROVIDER_TEMPLATES[entry.provider];
	const providerName = `${template?.displayName || entry.provider} #${entry.index}`;
	if (!entry.label) return providerName;
	return `${entry.label} — ${providerName}`;
}

/** Get the base provider type from a provider name, e.g. "openai-codex-2" -> "openai-codex" */
function getBaseProvider(providerName: string): string | undefined {
	// Direct match
	if (PROVIDER_TEMPLATES[providerName]) return providerName;
	// Strip trailing -N
	const match = providerName.match(/^(.+)-(\d+)$/);
	if (match && PROVIDER_TEMPLATES[match[1]]) return match[1];
	return undefined;
}

// ==========================================================================
// Model cloning
// ==========================================================================

function cloneModels(index: number) {
	const models = getCodexModels();
	return models.map((model) => ({ ...structuredClone(model), name: `${model.name} (#${index})` }));
}

// ==========================================================================
// Register a single subscription as a provider
// ==========================================================================

function registerSub(pi: ExtensionAPI, entry: SubEntry, streams: PoolManager["streams"]): void {
	const template = PROVIDER_TEMPLATES[entry.provider];
	if (!template) return;

	const name = subProviderName(entry);
	const provider = {
		...codexTransport,
		id: name,
		name: `ChatGPT Codex #${entry.index}`,
		auth: { oauth: { ...openaiCodexOAuth, name: `ChatGPT Codex #${entry.index}` } },
		// Pi composes overrides from getAllModels when present; do not inherit the base account's list.
		getAllModels: undefined,
		getModels: () => cloneModels(entry.index).map((model) => ({ ...model, provider: name })),
	};
	// Both catalogs derive aliases from the refreshed base catalog, preserving per-account overrides.
	accountRuntime.registerNativeProvider(provider);
	pi.registerProvider({
		...provider,
		refreshModels: async () => {
			await refreshAccountModels();
		},
		stream: streams.stream,
		streamSimple: streams.streamSimple,
	});
}

// ==========================================================================
// Custom selector script loader
// ==========================================================================

function resolveSelectorScriptPath(scriptPath: string): string {
	if (isAbsolute(scriptPath)) return scriptPath;
	if (scriptPath.startsWith("~/")) {
		const home = process.env.HOME || process.env.USERPROFILE || "";
		return join(home, scriptPath.slice(2));
	}
	// Resolve relative to global config directory
	return join(getAgentDir(), scriptPath);
}

// ==========================================================================
// Pool rotation engine
// ==========================================================================

function getPoolModels(pool: PoolConfig | undefined): Model<Api>[] {
	return buildPoolModels(pool, (provider) => [...accountRuntime.getModels(provider)]);
}

class PoolManager {
	private registered = new Set<string>();
	private cwd = process.cwd();
	private router: PoolRouter;
	private pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		this.router = this.createRouter(this.cwd);
	}

	private createRouter(cwd: string): PoolRouter {
		let catalog: ModelRuntime | undefined;
		let preparing: Promise<void> | undefined;
		const registered = new Set<string>();
		const prepare = () =>
			(preparing ??= (async () => {
				await refreshAccountModels();
				catalog ??= await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
				const pools = loadEffectiveConfig(cwd).pools.filter((pool) => pool.enabled);
				for (const pool of pools) {
					if (registered.has(pool.name)) continue;
					catalog.registerNativeProvider({
						...codexTransport,
						id: pool.name,
						name: pool.name,
						getAllModels: undefined,
						auth: {
							apiKey: { name: "Pool configuration", resolve: async () => ({ auth: {}, source: "Pool configuration" }) },
						},
						getModels: () =>
							getPoolModels(loadEffectiveConfig(cwd).pools.find((entry) => entry.name === pool.name && entry.enabled)),
					});
					registered.add(pool.name);
				}
				await catalog.refresh({ providers: pools.map((pool) => pool.name), allowNetwork: false });
			})().finally(() => {
				preparing = undefined;
			}));
		return new PoolRouter({
			prepare,
			state: getSharedPoolState,
			config: () => loadEffectiveConfig(cwd),
			member: getMember,
			hasAuth: (provider) => {
				const allowed = loadEffectiveConfig(cwd).allowedProviderNames;
				return (!allowed || allowed.includes(provider)) && readStoredCredential(provider)?.type === "oauth";
			},
			model: (provider, id) => accountRuntime.getModel(provider, id),
			poolModel: async (name, id) => catalog?.getModel(name, id),
			headerNames: (model) =>
				configuredHeaderNames(
					model,
					readConfig(join(getAgentDir(), "models.json"), (raw) => raw),
				),
			auth: async (model, signal) => {
				const runtime = isCodexProviderName(model.provider) ? accountRuntime : catalog;
				return runtime?.getAuth(model, { signal });
			},
			order: async (name, members, model, previous, prompt, signal) => {
				const pool = loadEffectiveConfig(cwd).pools.find((candidate) => candidate.name === name);
				if (pool?.strategy === "scheduled")
					return { members: getScheduledMemberOrder(pool, members, new Date()), ordered: true };
				if (pool?.strategy === "quota-first") {
					const state = getSharedPoolState().snapshot();
					const score = (provider: string) => {
						const quota = state.accounts[getMember(provider).key]?.quota;
						return quota && quota.kind !== "error" && quota.kind !== "missing-auth" ? quota.score : -1;
					};
					if (members.some((member) => score(member) >= 0))
						return {
							members: [...members].sort((left, right) => score(right) - score(left)),
							ordered: true,
						};
				}
				if (pool?.strategy === "custom") {
					try {
						if (!pool.selectorScript) throw new Error("No selector script configured");
						const orderedMembers = await selectCustomMember(
							resolveSelectorScriptPath(pool.selectorScript),
							pool,
							members,
							model,
							signal,
							previous,
							prompt,
						);
						if (orderedMembers) return { members: orderedMembers, ordered: true };
					} catch (error) {
						signal.throwIfAborted();
						this.pi.events.emit(
							"multi-pass:warning",
							`Pool ${name}: ${error instanceof Error ? error.message : String(error)}; using round-robin.`,
						);
					}
				}
				return { members, ordered: false };
			},
			checkLimits: (signal) => runQuotaChecks(collectQuotaAccountsForProject(cwd), signal, "limit"),
			transport: codexTransport,
			connections: codexConnections,
			status: (status) => this.pi.events.emit("multi-pass:status", status),
			warn: (message) => this.pi.events.emit("multi-pass:warning", message),
		});
	}

	get streams(): Pick<PoolRouter, "stream" | "streamSimple"> {
		return this.router;
	}

	registerAccounts(): void {
		this.pi.registerProvider({
			...codexTransport,
			getModels: getCodexModels,
			getAllModels: getCodexModels,
			refreshModels: async () => {
				await refreshAccountModels();
			},
			stream: this.streams.stream,
			streamSimple: this.streams.streamSimple,
		});
		const config = loadGlobalConfig();
		for (const entry of mergeConfigs(config, parseEnvConfig())) registerSub(this.pi, entry, this.streams);
	}

	setContext(ctx: ExtensionContext): void {
		if (this.cwd !== ctx.cwd) {
			this.cwd = ctx.cwd;
			// Inherited providers retain their original project scope when the parent changes sessions.
			for (const name of this.registered) this.pi.unregisterProvider(name);
			this.registered.clear();
			this.router = this.createRouter(ctx.cwd);
			this.registerAccounts();
		}
		this.loadPools(loadEffectiveConfig(ctx.cwd).pools);
	}

	loadPools(configs: PoolConfig[]): void {
		const enabled = new Set(configs.filter((pool) => pool.enabled).map((pool) => pool.name));
		for (const name of this.registered) {
			if (!enabled.has(name)) {
				this.pi.unregisterProvider(name);
				this.registered.delete(name);
			}
		}
		for (const pool of configs) {
			if (!pool.enabled || this.registered.has(pool.name)) continue;
			const conflict = poolProviderNameError(pool.name);
			if (conflict) throw new Error(conflict);
			const cwd = this.cwd;
			const configured = () =>
				loadEffectiveConfig(cwd).pools.find((candidate) => candidate.name === pool.name && candidate.enabled);
			this.pi.registerProvider({
				id: pool.name,
				name: pool.name,
				auth: {
					apiKey: {
						name: "Pool member accounts",
						check: async () =>
							configured()?.members.some((member) => readStoredCredential(member)?.type === "oauth")
								? { type: "api_key", source: "Pool member accounts" }
								: undefined,
						resolve: async () =>
							configured()?.members.some((member) => readStoredCredential(member)?.type === "oauth")
								? { auth: {}, source: "Pool member accounts" }
								: undefined,
					},
				},
				getModels: () => getPoolModels(configured()),
				refreshModels: async () => {
					await refreshAccountModels();
				},
				stream: this.router.stream,
				streamSimple: this.router.streamSimple,
			});
			this.registered.add(pool.name);
		}
	}

	async selectModel(ctx: ExtensionCommandContext, pool: PoolConfig): Promise<void> {
		const models = ctx.modelRegistry.getAll().filter((model) => model.provider === pool.name);
		const id = await showWrappedSelect(ctx, {
			title: `Models: ${pool.name}`,
			items: models.map((model) => ({ value: model.id, label: model.name })),
			initialValue: ctx.model?.id,
			confirmHint: "use",
		});
		const selected = models.find((model) => model.id === id);
		if (!selected) return;
		const success = await safeSetModel(this.pi, selected);
		ctx.ui.notify(
			success ? `Using ${pool.name}/${selected.id}.` : `Could not select ${pool.name}/${selected.id}.`,
			success ? "info" : "error",
		);
	}

	async renameSelection(ctx: ExtensionCommandContext, previous: string, next: string): Promise<void> {
		if (ctx.model?.provider !== previous) return;
		await ctx.modelRegistry.refresh({ allowNetwork: false });
		const selected = ctx.modelRegistry.find(next, ctx.model.id);
		if (selected && !(await safeSetModel(this.pi, selected)))
			ctx.ui.notify(`Select the renamed pool with /model ${next}.`, "warning");
	}

	getAvailableMembers(pool: PoolConfig, authStorage: { hasAuth(provider: string): boolean }): string[] {
		const state = getSharedPoolState().snapshot();
		const now = Date.now();
		return pool.members.filter((member) => {
			if (!authStorage.hasAuth(member)) return false;
			try {
				return unavailableUntil(state.accounts[getMember(member).key], now) <= now;
			} catch {
				return false;
			} // The status view reports invalid credentials per account.
		});
	}

	isMemberExhausted(pool: PoolConfig, provider: string): boolean {
		return (
			pool.members.includes(provider) &&
			unavailableUntil(getSharedPoolState().snapshot().accounts[getMember(provider).key]) > Date.now()
		);
	}
}

// ==========================================================================
// /subs command handlers
// ==========================================================================

function getSubscriptionSource(config: MultiPassConfig, entry: SubEntry): "config" | "env" {
	return config.subscriptions.find((s) => s.provider === entry.provider && s.index === entry.index) ? "config" : "env";
}

function formatSubscriptionMeta(
	entry: SubEntry,
	config: MultiPassConfig,
	authStorage: { hasAuth(provider: string): boolean },
): string {
	const name = subProviderName(entry);
	const hasAuth = authStorage.hasAuth(name);
	const status = hasAuth ? "[logged in]" : "[not logged in]";
	const source = getSubscriptionSource(config, entry);
	return `${status} (${source})`;
}

function formatSubscriptionListLine(
	entry: SubEntry,
	config: MultiPassConfig,
	authStorage: { hasAuth(provider: string): boolean },
): string {
	return `${subDisplayName(entry)} -- ${formatSubscriptionMeta(entry, config, authStorage)}`;
}

function getSwitchableProviderOptions(
	ctx: ExtensionContext | ExtensionCommandContext,
): Array<{ providerName: string; label: string; description: string }> {
	const config = loadEffectiveConfig(ctx.cwd);
	return accountProviders(config)
		.filter((provider) => getAuthStorage(ctx).hasAuth(provider))
		.map((providerName) => ({
			providerName,
			label: getProviderDisplayName(providerName, config.subscriptions),
			description: providerName === "openai-codex" ? "base provider" : "extra subscription",
		}));
}

async function handleSubsSwitch(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	requestedProviderName?: string,
): Promise<void> {
	const options = getSwitchableProviderOptions(ctx);
	if (options.length === 0) {
		const allowedProviderNames = loadEffectiveConfig(ctx.cwd).allowedProviderNames;
		const suffix =
			allowedProviderNames && allowedProviderNames.length > 0
				? ` for this project restriction (${allowedProviderNames.join(", ")})`
				: "";
		ctx.ui.notify(`No authenticated subscriptions are available to switch${suffix}.`, "info");
		return;
	}

	let providerName = requestedProviderName?.trim();
	if (!providerName) {
		providerName = await showWrappedSelect(ctx, {
			title: "Switch Subscription",
			subtitle: "Select the subscription/provider to use now.",
			items: options.map((option) => ({
				value: option.providerName,
				label: option.label,
				description: option.description,
			})),
			initialValue: ctx.model?.provider,
			confirmHint: "switch",
			cancelHint: "back",
		});
		if (!providerName) return;
	}

	const selected = options.find((option) => option.providerName === providerName);
	if (!selected) {
		ctx.ui.notify(`Subscription not available for switching: ${providerName}`, "error");
		return;
	}

	const nextModel = findSelectableModelForProvider(ctx, selected.providerName, ctx.model?.id);
	if (!nextModel) {
		ctx.ui.notify(`No selectable models found for ${selected.label}.`, "error");
		return;
	}
	if (ctx.model?.provider === nextModel.provider && ctx.model?.id === nextModel.id) {
		ctx.ui.notify(`Already using ${selected.label} (${nextModel.id}).`, "info");
		return;
	}

	const success = await safeSetModel(pi, nextModel);
	if (!success) {
		ctx.ui.notify(`Failed to switch to ${selected.label}.`, "error");
		return;
	}
	ctx.ui.notify(`Switched to ${selected.label} (${nextModel.id}).`, "info");
}

async function renameSubscriptionLabel(ctx: ExtensionCommandContext, entry: SubEntry): Promise<void> {
	const previousName = subDisplayName(entry);
	const nextLabel = await ctx.ui.input(
		"Friendly label (optional)",
		entry.label || "e.g. work, personal, team, outlook",
	);
	if (nextLabel === undefined) return;

	const updated = updateGlobalConfig((config) => {
		const saved = config.subscriptions.find((candidate) => subProviderName(candidate) === subProviderName(entry));
		if (!saved) throw new Error(`Subscription ${subProviderName(entry)} no longer exists`);
		saved.label = nextLabel.trim() || undefined;
		return saved;
	});

	const nextName = subDisplayName(updated);
	if (nextName === previousName) {
		ctx.ui.notify(`No changes for ${nextName}.`, "info");
		return;
	}

	ctx.ui.notify(`Updated ${previousName} -> ${nextName}`, "info");
}

async function removeSubscriptionEntry(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	entry: SubEntry,
	poolManager: PoolManager,
): Promise<void> {
	const name = subProviderName(entry);
	const expectedEntry = structuredClone(entry);
	const expectedCredential = readStoredCredential(name);
	const confirmed = await ctx.ui.confirm(
		"Confirm removal",
		`Remove ${subDisplayName(entry)}?\nThis will also logout if authenticated.`,
	);
	if (!confirmed) return;

	let removed = false;
	try {
		await new FileAuthStorageBackend().withLockAsync(async (source) => {
			const credentials = getRecord(JSON.parse(source ?? "{}"));
			if (!credentials) throw new Error("Invalid auth.json: expected an object");
			if (!isDeepStrictEqual(credentials[name], expectedCredential))
				throw new Error(`${name} was re-authenticated in another window; reopen the subscription list`);
			// Commit validated configuration before removing the reviewed credential.
			updateGlobalConfig((config) => removeSubscription(config, expectedEntry));
			removed = true;
			delete credentials[name];
			return { result: undefined, next: `${JSON.stringify(credentials, null, 2)}\n` };
		});
	} catch (error) {
		if (removed) {
			reloadPoolManagerForCurrentProject(ctx, poolManager);
			throw new Error(`Removed ${name} from configuration, but credential cleanup failed; retry /logout ${name}`, {
				cause: error,
			});
		}
		throw error;
	}
	pi.unregisterProvider(name);
	accountRuntime.unregisterProvider(name);
	await ctx.modelRegistry.refresh();
	reloadPoolManagerForCurrentProject(ctx, poolManager);
	ctx.ui.notify(`Removed ${subDisplayName(entry)}`, "info");
}

async function showSubscriptionActions(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: MultiPassConfig,
	entry: SubEntry,
	poolManager: PoolManager,
): Promise<void> {
	const source = getSubscriptionSource(config, entry);
	if (source === "env") {
		await showWrappedSelect(ctx, {
			title: `Subscription: ${subDisplayName(entry)}`,
			subtitle: "This entry comes from MULTI_SUB and is read-only here.",
			items: [
				{
					value: subProviderName(entry),
					label: formatSubscriptionListLine(entry, config, getAuthStorage(ctx)),
				},
			],
			confirmHint: "back",
			cancelHint: "back",
		});
		return;
	}

	const name = subProviderName(entry);
	const hasAuth = getAuthStorage(ctx).hasAuth(name);
	const actionItems: SelectItem[] = [
		{ value: "rename", label: "rename", description: "Change friendly label" },
		hasAuth
			? { value: "logout", label: "logout", description: "Log out this subscription" }
			: { value: "login", label: "login", description: "Show login instructions" },
		{ value: "remove", label: "remove", description: "Remove this subscription" },
	];

	const action = await showWrappedSelect(ctx, {
		title: subDisplayName(entry),
		subtitle: "Escape returns to the subscriptions list.",
		items: actionItems,
		confirmHint: "open",
		cancelHint: "back",
	});
	if (!action) return;

	if (action === "rename") {
		return renameSubscriptionLabel(ctx, entry);
	}
	if (action === "login") {
		await loginSubscription(ctx, entry);
		return;
	}
	if (action === "logout") {
		await getAuthStorage(ctx).logout(name);
		await ctx.modelRegistry.refresh();
		ctx.ui.notify(`Logged out of ${subDisplayName(entry)}`, "info");
		return;
	}
	if (action === "remove") {
		return removeSubscriptionEntry(pi, ctx, entry, poolManager);
	}
}

async function handleSubsList(pi: ExtensionAPI, ctx: ExtensionCommandContext, poolManager: PoolManager): Promise<void> {
	let preferredProviderName: string | undefined = ctx.model?.provider;

	while (true) {
		const config = loadGlobalConfig();
		const envEntries = parseEnvConfig();
		const all = mergeConfigs(config, envEntries);

		if (all.length === 0) {
			ctx.ui.notify("No extra subscriptions configured. Use /subs add to create one.", "info");
			return;
		}

		const selectedProviderName = await showWrappedSelect(ctx, {
			title: "Extra Subscriptions",
			subtitle: "Select a subscription for quick actions.",
			items: all.map((entry) => ({
				value: subProviderName(entry),
				label: subDisplayName(entry),
				description: formatSubscriptionMeta(entry, config, getAuthStorage(ctx)),
			})),
			initialValue: preferredProviderName,
			confirmHint: "open",
			cancelHint: "close",
		});
		if (!selectedProviderName) return;

		preferredProviderName = selectedProviderName;
		const entry = all.find((candidate) => subProviderName(candidate) === selectedProviderName);
		if (!entry) continue;
		await showSubscriptionActions(pi, ctx, config, entry, poolManager);
	}
}

async function handleSubsAdd(pi: ExtensionAPI, ctx: ExtensionCommandContext, poolManager: PoolManager): Promise<void> {
	const providerItems: SelectItem[] = SUPPORTED_PROVIDERS.map((provider) => ({
		value: provider,
		label: provider,
		description: PROVIDER_TEMPLATES[provider]?.displayName,
	}));

	const provider = await showWrappedSelect(ctx, {
		title: "Select provider to add",
		items: providerItems,
		confirmHint: "select",
		cancelHint: "close",
	});
	if (!provider) return;

	if (!PROVIDER_TEMPLATES[provider]) {
		ctx.ui.notify(`Unknown provider: ${provider}`, "error");
		return;
	}

	const label = await ctx.ui.input("Label (optional)", "e.g. work, personal");
	if (label === undefined) return;

	const entry = updateGlobalConfig((config) => addSubscription(config, label, parseEnvConfig()));

	registerSub(pi, entry, poolManager.streams);
	await ctx.modelRegistry.refresh();

	const loginNow = await ctx.ui.confirm(subDisplayName(entry), `Created ${subDisplayName(entry)}.\n\nLogin now?`);

	if (loginNow) {
		await loginSubscription(ctx, entry);
	} else {
		ctx.ui.notify(`Added ${subDisplayName(entry)}. Use /subs login to authenticate.`, "info");
	}
}

async function handleSubsRemove(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const config = loadGlobalConfig();
	if (config.subscriptions.length === 0) {
		ctx.ui.notify("No saved subscriptions to remove.", "info");
		return;
	}

	const selectedProviderName = await showWrappedSelect(ctx, {
		title: "Remove subscription",
		subtitle: "Select a saved subscription to remove.",
		initialValue: ctx.model?.provider,
		items: config.subscriptions.map((entry) => ({
			value: subProviderName(entry),
			label: subDisplayName(entry),
			description: getAuthStorage(ctx).hasAuth(subProviderName(entry)) ? "logged in" : "not logged in",
		})),
		confirmHint: "remove",
		cancelHint: "back",
	});
	if (!selectedProviderName) return;

	const entry = config.subscriptions.find((candidate) => subProviderName(candidate) === selectedProviderName);
	if (!entry) return;

	return removeSubscriptionEntry(pi, ctx, entry, poolManager);
}

function openBrowser(target: string): void {
	const [command, args] =
		process.platform === "darwin"
			? ["open", [target]]
			: process.platform === "win32"
				? ["rundll32", ["url.dll,FileProtocolHandler", target]]
				: ["xdg-open", [target]];
	spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => {
		// The URL is still shown in the notification if no browser launcher exists.
	});
}

async function loginSubscription(ctx: ExtensionCommandContext, entry: SubEntry): Promise<void> {
	const providerName = subProviderName(entry);
	if (!PROVIDER_TEMPLATES[entry.provider]) {
		ctx.ui.notify(`Unsupported subscription provider: ${entry.provider}`, "error");
		return;
	}

	try {
		await accountRuntime.login(providerName, "oauth", createOAuthInteraction(ctx.ui, openBrowser));
		await ctx.modelRegistry.refresh();
		ctx.ui.notify(`Logged in to ${subDisplayName(entry)}.`, "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Login failed for ${subDisplayName(entry)}: ${message}`, "error");
	}
}

async function handleSubsLogin(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const all = mergeConfigs(config, envEntries);

	const notLoggedIn = all.filter((entry) => !getAuthStorage(ctx).hasAuth(subProviderName(entry)));

	if (notLoggedIn.length === 0) {
		ctx.ui.notify(
			all.length === 0
				? "No subscriptions configured. Use /subs add first."
				: "All subscriptions are already logged in.",
			"info",
		);
		return;
	}

	const selectedProviderName = await showWrappedSelect(ctx, {
		title: "Login to subscription",
		subtitle: "Select a subscription to see login instructions.",
		initialValue: ctx.model?.provider,
		items: notLoggedIn.map((entry) => ({
			value: subProviderName(entry),
			label: subDisplayName(entry),
			description: "not logged in",
		})),
		confirmHint: "open",
		cancelHint: "back",
	});
	if (!selectedProviderName) return;

	const entry = notLoggedIn.find((candidate) => subProviderName(candidate) === selectedProviderName);
	if (!entry) return;

	await loginSubscription(ctx, entry);
}

async function handleSubsLogout(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const all = mergeConfigs(config, envEntries);

	const loggedIn = all.filter((entry) => getAuthStorage(ctx).hasAuth(subProviderName(entry)));

	if (loggedIn.length === 0) {
		ctx.ui.notify("No subscriptions are currently logged in.", "info");
		return;
	}

	const selectedProviderName = await showWrappedSelect(ctx, {
		title: "Logout from subscription",
		subtitle: "Select a subscription to log out.",
		initialValue: ctx.model?.provider,
		items: loggedIn.map((entry) => ({
			value: subProviderName(entry),
			label: subDisplayName(entry),
			description: "logged in",
		})),
		confirmHint: "logout",
		cancelHint: "back",
	});
	if (!selectedProviderName) return;

	const entry = loggedIn.find((candidate) => subProviderName(candidate) === selectedProviderName);
	if (!entry) return;

	await getAuthStorage(ctx).logout(subProviderName(entry));
	await ctx.modelRegistry.refresh();
	ctx.ui.notify(`Logged out of ${subDisplayName(entry)}`, "info");
}

async function handleSubsStatus(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const all = mergeConfigs(config, envEntries);

	if (all.length === 0) {
		ctx.ui.notify("No extra subscriptions configured.", "info");
		return;
	}

	const lines: string[] = [];
	for (const entry of all) {
		const name = subProviderName(entry);
		const cred = getAuthStorage(ctx).get(name);
		const hasAuth = getAuthStorage(ctx).hasAuth(name);

		let status: string;
		if (!hasAuth) {
			status = "not logged in";
		} else if (cred?.type === "oauth") {
			const expiresIn = typeof cred.expires === "number" ? cred.expires - Date.now() : 0;
			if (expiresIn > 0) {
				const mins = Math.round(expiresIn / 60000);
				status = `logged in (expires ${mins}m)`;
			} else {
				status = "logged in (token expired, will refresh)";
			}
		} else {
			status = "logged in (api key)";
		}

		const modelCount = getCodexModels().length;
		const source = config.subscriptions.find((s) => s.provider === entry.provider && s.index === entry.index)
			? "saved"
			: "env";

		// Check if in any pool
		const inPools = config.pools.filter((p) => p.members.includes(name)).map((p) => p.name);
		const poolInfo = inPools.length > 0 ? ` | pools: ${inPools.join(", ")}` : "";

		lines.push(`${subDisplayName(entry)} | ${status} | ${modelCount} models | ${source}${poolInfo}`);
	}

	await showWrappedSelect(ctx, {
		title: "Subscription Status",
		subtitle: "Press Enter or Escape to go back.",
		items: lines.map((line, index) => ({ value: `${index}:${line}`, label: line })),
		confirmHint: "back",
		cancelHint: "back",
	});
}

// ==========================================================================
// /pool command handlers
// ==========================================================================

/** Get all provider names that belong to a base provider type (including the original) */
function getAllProvidersForBase(baseProvider: string, allSubs: SubEntry[]): string[] {
	const providers = [baseProvider]; // original
	for (const entry of allSubs) {
		if (entry.provider === baseProvider) {
			providers.push(subProviderName(entry));
		}
	}
	return providers;
}

function createPoolValidationMessage(members: string[]): string | null {
	if (members.length < 1) {
		return "Pool needs at least 1 member.";
	}
	return null;
}

function buildPoolConfig(input: {
	name: string;
	baseProvider: string;
	members: string[];
	enabled?: boolean;
	strategy?: PoolStrategy;
	memberSchedule?: Record<string, MemberSchedule>;
	selectorScript?: string;
}): { ok: true; pool: PoolConfig } | { ok: false; error: string } {
	const name = input.name.trim();
	if (!name) {
		return { ok: false, error: "Pool name is required." };
	}
	const nameError = poolProviderNameError(name);
	if (nameError) return { ok: false, error: nameError };
	const validation = createPoolValidationMessage(input.members);
	if (validation) {
		return { ok: false, error: validation };
	}
	const pool: PoolConfig = {
		name,
		baseProvider: input.baseProvider,
		members: [...input.members],
		enabled: input.enabled ?? true,
		strategy: input.strategy ?? "round-robin",
	};
	if (input.memberSchedule && Object.keys(input.memberSchedule).length > 0) {
		pool.memberSchedule = input.memberSchedule;
	}
	if (input.selectorScript) {
		pool.selectorScript = input.selectorScript;
	}
	return { ok: true, pool };
}

function reloadPoolManagerForCurrentProject(ctx: ExtensionCommandContext, poolManager: PoolManager): void {
	poolManager.loadPools(loadEffectiveConfig(ctx.cwd).pools);
}

async function renamePoolConfig(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
	config: MultiPassConfig,
	pool: PoolConfig,
): Promise<void> {
	const previousName = pool.name;
	const nextName = await ctx.ui.input("Pool name", pool.name);
	if (nextName === undefined) return;

	const trimmedName = nextName.trim();
	if (!trimmedName) {
		ctx.ui.notify("Pool name is required.", "warning");
		return;
	}
	if (trimmedName === previousName) {
		ctx.ui.notify(`No changes for pool "${previousName}".`, "info");
		return;
	}
	if (config.pools.some((candidate) => candidate.name === trimmedName)) {
		ctx.ui.notify(`Pool "${trimmedName}" already exists.`, "warning");
		return;
	}

	const nameError = poolProviderNameError(trimmedName);
	if (nameError) {
		ctx.ui.notify(nameError, "warning");
		return;
	}
	const updatedEntries = updateGlobalConfig((latest) => {
		if (latest.pools.some((candidate) => candidate.name === trimmedName))
			throw new Error(`Pool "${trimmedName}" already exists`);
		requireNamed(latest.pools, previousName).name = trimmedName;
		for (const preset of latest.presets)
			for (const entry of preset.entries) {
				if (entry.provider === previousName) entry.provider = trimmedName;
			}
		return renamePoolReferences(latest.chains, previousName, trimmedName);
	});
	reloadPoolManagerForCurrentProject(ctx, poolManager);
	await poolManager.renameSelection(ctx, previousName, trimmedName);
	ctx.ui.notify(
		updatedEntries > 0
			? `Renamed pool "${previousName}" -> "${trimmedName}" and updated ${updatedEntries} chain entr${updatedEntries === 1 ? "y" : "ies"}.`
			: `Renamed pool "${previousName}" -> "${trimmedName}".`,
		"info",
	);
}

async function editPoolMembers(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
	config: MultiPassConfig,
	pool: PoolConfig,
): Promise<void> {
	const envEntries = parseEnvConfig();
	const allSubs = mergeConfigs(config, envEntries);
	const availableProviders = getAllProvidersForBase(pool.baseProvider, allSubs);
	const selectedMembers = [...pool.members];

	while (true) {
		const removableItems: SelectItem[] = selectedMembers.map((member) => ({
			value: `remove:${member}`,
			label: `remove ${member}`,
			description: getAuthStorage(ctx).hasAuth(member) ? "logged in" : "not logged in",
		}));
		const addableItems: SelectItem[] = availableProviders
			.filter((providerName) => !selectedMembers.includes(providerName))
			.map((providerName) => ({
				value: `add:${providerName}`,
				label: `add ${providerName}`,
				description: getAuthStorage(ctx).hasAuth(providerName) ? "logged in" : "not logged in",
			}));

		const action = await showWrappedSelect(ctx, {
			title: `Pool Members: ${pool.name}`,
			subtitle: [
				`Base provider: ${pool.baseProvider}`,
				`Selected (${selectedMembers.length}): ${selectedMembers.join(", ") || "none"}`,
				"Choose add/remove entries, then save when done.",
			].join("\n"),
			items: [
				{
					value: "save",
					label: "save",
					description: "Persist member changes",
				},
				...removableItems,
				...addableItems,
			],
			confirmHint: "select",
			cancelHint: "back",
		});
		if (!action) return;

		if (action === "save") {
			const validation = createPoolValidationMessage(selectedMembers);
			if (validation) {
				ctx.ui.notify(validation, "warning");
				continue;
			}
			const changed =
				pool.members.length !== selectedMembers.length ||
				pool.members.some((member, index) => member !== selectedMembers[index]);
			if (!changed) {
				ctx.ui.notify(`No changes for pool "${pool.name}".`, "info");
				return;
			}
			updateGlobalConfig((latest) => {
				const target = requireNamed(latest.pools, pool.name);
				if (
					target.members.length !== pool.members.length ||
					target.members.some((member, index) => member !== pool.members[index])
				)
					throw new Error("Pool members changed in another window; reopen the menu");
				const available = new Set(getAllProvidersForBase(target.baseProvider, mergeConfigs(latest, parseEnvConfig())));
				if (selectedMembers.some((member) => !available.has(member)))
					throw new Error("A selected subscription was removed; reopen the menu");
				target.members = [...selectedMembers];
				for (const member of Object.keys(target.memberSchedule ?? {})) {
					if (!target.members.includes(member)) delete target.memberSchedule?.[member];
				}
			});
			pool.members = [...selectedMembers];
			reloadPoolManagerForCurrentProject(ctx, poolManager);
			ctx.ui.notify(
				`Updated pool "${pool.name}" with ${pool.members.length} member${pool.members.length === 1 ? "" : "s"}: ${pool.members.join(", ")}.`,
				"info",
			);
			return;
		}

		if (action.startsWith("remove:")) {
			const member = action.slice("remove:".length);
			const index = selectedMembers.indexOf(member);
			if (index >= 0) selectedMembers.splice(index, 1);
			continue;
		}

		if (action.startsWith("add:")) {
			const member = action.slice("add:".length);
			if (!selectedMembers.includes(member)) {
				selectedMembers.push(member);
			}
		}
	}
}

async function promptPoolStrategy(
	ctx: ExtensionCommandContext,
	name: string,
	members: string[],
	current?: PoolStrategy,
): Promise<Pick<PoolConfig, "strategy" | "memberSchedule" | "selectorScript"> | undefined> {
	const selected = await showWrappedSelect(ctx, {
		title: current ? `Strategy: ${name}` : "Selection strategy",
		subtitle: current ? `Currently: ${current}` : undefined,
		items: [
			{ value: "round-robin", label: "round-robin", description: "Rotate members sequentially (default)" },
			{ value: "quota-first", label: "quota-first", description: "Prefer the member with the most remaining quota" },
			{ value: "scheduled", label: "scheduled", description: "Use per-member time windows and priority roles" },
			{ value: "custom", label: "custom", description: "Delegate to a JS selector script" },
		],
		initialValue: current ?? "round-robin",
		confirmHint: "select",
		cancelHint: "back",
	});
	if (!selected) return undefined;
	const strategy = selected as PoolStrategy;
	const config = await promptStrategyConfig(ctx, strategy, members);
	return config ? { strategy, ...config } : undefined;
}

async function promptStrategyConfig(
	ctx: ExtensionCommandContext,
	strategy: PoolStrategy,
	members: string[],
): Promise<Pick<PoolConfig, "memberSchedule" | "selectorScript"> | undefined> {
	if (strategy === "round-robin" || strategy === "quota-first") return {};
	if (strategy === "scheduled") {
		const memberSchedule: Record<string, MemberSchedule> = {};
		for (const member of members) {
			const rolePick = await ctx.ui.select(`Role for ${member}`, [
				"default -- Always available (no schedule needed)",
				"preferred -- Only during time windows",
				"overflow -- Last resort",
			]);
			if (!rolePick) return undefined;

			const role = rolePick.startsWith("preferred")
				? "preferred"
				: rolePick.startsWith("overflow")
					? "overflow"
					: undefined;
			if (role === "preferred") {
				const windowDef = await ctx.ui.input(`Time window for ${member}`, "e.g. 9-17 mon-fri");
				if (windowDef === undefined) return undefined;
				if (windowDef.trim()) {
					const window = parseScheduleWindowInput(windowDef);
					if (!window) throw new Error(`Invalid schedule for ${member}: ${windowDef}`);
					memberSchedule[member] = { role, windows: [window] };
				} else {
					memberSchedule[member] = { role, windows: [] };
				}
			} else if (role === "overflow") {
				memberSchedule[member] = { role };
			}
		}
		return { memberSchedule: Object.keys(memberSchedule).length > 0 ? memberSchedule : undefined };
	}

	const scriptPath = await ctx.ui.input("Selector script path", "e.g. selectors/my-pool.js (relative to ~/.pi/agent/)");
	if (scriptPath === undefined) return undefined;
	if (!scriptPath.trim()) {
		ctx.ui.notify("A script path is required. Settings unchanged.", "warning");
		return undefined;
	}
	const selectorScript = scriptPath.trim();
	const resolved = resolveSelectorScriptPath(selectorScript);
	if (!existsSync(resolved)) ctx.ui.notify(`Warning: script not found at ${resolved}.`, "warning");
	return { selectorScript };
}

async function promptForPoolDefinition(
	ctx: ExtensionCommandContext,
	options?: {
		allowOverwrite?: boolean;
		resumeChainName?: string;
	},
): Promise<{ pool: PoolConfig; previous?: PoolConfig } | undefined> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const allSubs = mergeConfigs(config, envEntries);
	const providerLabels = SUPPORTED_PROVIDERS.map((p) => {
		const t = PROVIDER_TEMPLATES[p];
		return `${p} -- ${t.displayName}`;
	});

	const selectedProvider = await ctx.ui.select("Pool base provider", providerLabels);
	if (!selectedProvider) return undefined;
	const baseProvider = selectedProvider.split(" -- ")[0];

	const poolName = await ctx.ui.input("Pool name", `e.g. ${baseProvider}-pool`);
	if (!poolName?.trim()) return undefined;

	const allProviders = getAllProvidersForBase(baseProvider, allSubs);
	const authedProviders = allProviders.filter((p) => getAuthStorage(ctx).hasAuth(p));

	if (authedProviders.length === 0) {
		ctx.ui.notify(`No authenticated ${baseProvider} subscriptions found. Login first with /subs login.`, "warning");
		return undefined;
	}

	const members: string[] = [];
	let selecting = true;
	while (selecting) {
		const remaining = allProviders.filter((p) => !members.includes(p));
		if (remaining.length === 0) break;

		const optionsList = [
			`--- Selected (${members.length}): ${members.join(", ") || "none"} ---`,
			...remaining.map((p) => {
				const authed = getAuthStorage(ctx).hasAuth(p);
				return `${p} ${authed ? "[logged in]" : "[not logged in]"}`;
			}),
			"[Done - create pool]",
		];

		const picked = await ctx.ui.select("Add members ([Done] saves, Esc cancels)", optionsList);
		if (!picked) {
			ctx.ui.notify(`Cancelled pool creation${poolName ? ` for "${poolName}"` : ""}.`, "info");
			return undefined;
		}
		if (picked.startsWith("---")) {
			continue;
		}
		if (picked === "[Done - create pool]") {
			if (members.length === 0) {
				ctx.ui.notify("Select at least one member.", "warning");
				continue;
			}
			selecting = false;
			continue;
		}

		const provName = picked.split(" ")[0];
		if (provName && allProviders.includes(provName)) {
			members.push(provName);
		}
	}

	const strategyConfig = await promptPoolStrategy(ctx, poolName, members);
	if (!strategyConfig) return undefined;

	const built = buildPoolConfig({
		name: poolName,
		baseProvider,
		members,
		enabled: true,
		...strategyConfig,
	});
	if (!built.ok) {
		ctx.ui.notify(built.error, "warning");
		return undefined;
	}

	const existing = config.pools.find((pool) => pool.name === built.pool.name);
	if (existing && !options?.allowOverwrite) {
		ctx.ui.notify(`Pool "${built.pool.name}" already exists.`, "warning");
		return undefined;
	}
	if (existing && options?.allowOverwrite) {
		const overwrite = await ctx.ui.confirm("Pool exists", `Pool "${built.pool.name}" already exists. Overwrite?`);
		if (!overwrite) return undefined;
	}

	if (options?.resumeChainName) {
		ctx.ui.notify(`Prepared pool "${built.pool.name}" for chain "${options.resumeChainName}".`, "info");
	}

	return { pool: built.pool, previous: existing };
}

async function createAndPersistPool(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
	options?: {
		allowOverwrite?: boolean;
		resumeChainName?: string;
	},
): Promise<PoolConfig | undefined> {
	const definition = await promptForPoolDefinition(ctx, options);
	if (!definition) return undefined;
	const { pool, previous } = definition;
	const action = updateGlobalConfig((config) => replaceNamed(config.pools, pool, previous));
	reloadPoolManagerForCurrentProject(ctx, poolManager);

	const resumeSuffix = options?.resumeChainName ? ` Chain builder resumed for "${options.resumeChainName}".` : "";
	ctx.ui.notify(
		`${action === "created" ? "Created" : "Updated"} pool "${pool.name}" with ${pool.members.length} member${pool.members.length === 1 ? "" : "s"}: ${pool.members.join(", ")}.${resumeSuffix}`,
		"info",
	);
	return pool;
}

function getSelectableModelsForPool(pool: PoolConfig): string[] {
	return [...new Set(pool.members.flatMap((member) => accountRuntime.getModels(member).map((model) => model.id)))];
}

function createChainValidationError(config: MultiPassConfig, chain: ChainConfig): string | null {
	if (!chain.name.trim()) {
		return "Chain name is required.";
	}
	if (findChainByName(config.chains, chain.name)) {
		return `Chain "${chain.name}" already exists.`;
	}
	if (chain.entries.length === 0) {
		return `Chain "${chain.name}" needs at least 1 entry.`;
	}

	for (const entry of chain.entries) {
		const pool = config.pools.find((candidate) => candidate.name === entry.pool);
		if (!pool) {
			return `Chain entry pool "${entry.pool}" does not exist.`;
		}
		const selectableModels = getSelectableModelsForPool(pool);
		if (selectableModels.length === 0) {
			return `Pool "${pool.name}" has no selectable models for ${pool.baseProvider}.`;
		}
		if (!selectableModels.includes(entry.model)) {
			return `Model "${entry.model}" is not available for pool "${pool.name}".`;
		}
	}

	return null;
}

function buildChainConfig(
	config: MultiPassConfig,
	input: { name: string; entries: ChainEntryConfig[]; enabled?: boolean },
): { ok: true; chain: ChainConfig } | { ok: false; error: string } {
	const chain: ChainConfig = {
		name: input.name.trim(),
		entries: input.entries.map((entry) => ({ ...entry })),
		enabled: input.enabled ?? true,
	};
	const validationError = createChainValidationError(config, chain);
	if (validationError) {
		return { ok: false, error: validationError };
	}
	return { ok: true, chain };
}

async function handlePoolCreate(ctx: ExtensionCommandContext, poolManager: PoolManager): Promise<void> {
	await createAndPersistPool(ctx, poolManager, { allowOverwrite: true });
}

async function inspectPoolConfig(
	ctx: ExtensionCommandContext,
	pool: PoolConfig,
	poolManager: PoolManager,
): Promise<void> {
	await showWrappedSelect(ctx, {
		title: `Pool Status: ${pool.name}`,
		subtitle: "Press Enter or Escape to go back to the pools list.",
		items: formatPoolStatusLines(pool, getAuthStorage(ctx), poolManager).map((line, index) => ({
			value: `${index}:${line}`,
			label: line,
		})),
		confirmHint: "back",
		cancelHint: "back",
	});
}

async function togglePoolConfig(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
	pool: PoolConfig,
): Promise<void> {
	pool.enabled = updateGlobalConfig((config) => {
		const target = requireNamed(config.pools, pool.name);
		target.enabled = !target.enabled;
		return target.enabled;
	});
	reloadPoolManagerForCurrentProject(ctx, poolManager);
	ctx.ui.notify(`Pool "${pool.name}" is now ${pool.enabled ? "enabled" : "disabled"}`, "info");
}

async function changePoolStrategy(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
	original: PoolConfig,
): Promise<void> {
	const pool = structuredClone(original);
	const current = pool.strategy || "round-robin";
	const strategyConfig = await promptPoolStrategy(ctx, pool.name, pool.members, current);
	if (!strategyConfig) return;
	const nextStrategy = strategyConfig.strategy;
	pool.strategy = nextStrategy === "round-robin" ? undefined : nextStrategy;
	pool.memberSchedule = strategyConfig.memberSchedule;
	pool.selectorScript = strategyConfig.selectorScript;

	updateGlobalConfig((config) => {
		const target = requireNamed(config.pools, pool.name);
		for (const key of ["members", "strategy", "memberSchedule", "selectorScript"] as const) {
			if (!isDeepStrictEqual(target[key], original[key]))
				throw new Error("Pool strategy or members changed in another window; reopen the menu");
		}
		target.strategy = pool.strategy;
		target.memberSchedule = pool.memberSchedule;
		target.selectorScript = pool.selectorScript;
	});
	reloadPoolManagerForCurrentProject(ctx, poolManager);
	ctx.ui.notify(`Pool "${pool.name}" strategy changed to ${nextStrategy}.`, "info");
}

async function removePoolConfig(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
	config: MultiPassConfig,
	pool: PoolConfig,
): Promise<boolean> {
	const referencedEntries = config.chains.reduce(
		(count, chain) => count + chain.entries.filter((entry) => entry.pool === pool.name).length,
		0,
	);
	const confirmed = await ctx.ui.confirm(
		"Confirm removal",
		referencedEntries > 0
			? `Remove pool "${pool.name}"? (Subscriptions are kept.)\n\nThis will also remove ${referencedEntries} chain entr${referencedEntries === 1 ? "y" : "ies"} that reference this pool.`
			: `Remove pool "${pool.name}"? (Subscriptions are kept.)`,
	);
	if (!confirmed) return false;

	const { removedEntries, removedChains } = updateGlobalConfig((latest) => {
		const pruned = pruneRemovedPoolReferences(latest.chains, new Set([pool.name]));
		latest.chains = pruned.chains;
		latest.pools = latest.pools.filter((candidate) => candidate.name !== pool.name);
		for (const preset of latest.presets)
			preset.entries = preset.entries.filter((entry) => entry.provider !== pool.name);
		latest.presets = latest.presets.filter((preset) => preset.entries.length > 0);
		return pruned;
	});
	reloadPoolManagerForCurrentProject(ctx, poolManager);

	let message = `Removed pool "${pool.name}"`;
	if (removedEntries > 0) {
		message += ` and ${removedEntries} linked chain entr${removedEntries === 1 ? "y" : "ies"}`;
	}
	if (removedChains > 0) {
		message += ` (${removedChains} empty chain${removedChains === 1 ? "" : "s"} deleted)`;
	}
	ctx.ui.notify(`${message}.`, "info");
	return true;
}

async function showPoolActions(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
	config: MultiPassConfig,
	pool: PoolConfig,
): Promise<"removed" | undefined> {
	const currentStrategy = pool.strategy || "round-robin";
	const action = await showWrappedSelect(ctx, {
		title: pool.name,
		subtitle: "Escape returns to the pools list.",
		items: [
			{ value: "models", label: "models", description: "Choose a model from this pool" },
			{ value: "inspect", label: "inspect", description: "View pool health and member status" },
			{ value: "rename", label: "rename", description: "Change pool name" },
			{ value: "members", label: "members", description: "Add or remove pool members" },
			{
				value: "strategy",
				label: "strategy",
				description: `Currently ${currentStrategy}`,
			},
			{
				value: "toggle",
				label: pool.enabled ? "disable" : "enable",
				description: `Currently ${pool.enabled ? "enabled" : "disabled"}`,
			},
			{ value: "remove", label: "remove", description: "Delete this pool (subscriptions are kept)" },
		],
		confirmHint: "open",
		cancelHint: "back",
	});
	if (!action) return undefined;

	if (action === "models") {
		await poolManager.selectModel(ctx, pool);
		return undefined;
	}
	if (action === "inspect") {
		await inspectPoolConfig(ctx, pool, poolManager);
		return undefined;
	}
	if (action === "rename") {
		await renamePoolConfig(ctx, poolManager, config, pool);
		return undefined;
	}
	if (action === "members") {
		await editPoolMembers(ctx, poolManager, config, pool);
		return undefined;
	}
	if (action === "strategy") {
		await changePoolStrategy(ctx, poolManager, pool);
		return undefined;
	}
	if (action === "toggle") {
		await togglePoolConfig(ctx, poolManager, pool);
		return undefined;
	}
	if (action === "remove") {
		const removed = await removePoolConfig(ctx, poolManager, config, pool);
		return removed ? "removed" : undefined;
	}
	return undefined;
}

async function handlePoolList(ctx: ExtensionCommandContext, poolManager: PoolManager): Promise<void> {
	let preferredPoolName: string | undefined;

	while (true) {
		const config = loadGlobalConfig();
		const pools = config.pools;

		if (pools.length === 0) {
			ctx.ui.notify("No pools configured. Use /pool create to make one.", "info");
			return;
		}

		const selectedPoolName = await showWrappedSelect(ctx, {
			title: "Pools",
			subtitle: "Select a pool for quick actions.",
			items: pools.map((pool) => ({
				value: pool.name,
				label: pool.name,
				description: formatPoolListDescription(pool, getAuthStorage(ctx), poolManager),
			})),
			initialValue: preferredPoolName,
			confirmHint: "open",
			cancelHint: "close",
		});
		if (!selectedPoolName) return;

		preferredPoolName = selectedPoolName;
		const pool = config.pools.find((candidate) => candidate.name === selectedPoolName);
		if (!pool) continue;
		const result = await showPoolActions(ctx, poolManager, config, pool);
		if (result === "removed") {
			preferredPoolName = undefined;
			continue;
		}
		preferredPoolName = pool.name;
	}
}

async function handlePoolToggle(ctx: ExtensionCommandContext, poolManager: PoolManager): Promise<void> {
	const config = loadGlobalConfig();
	if (config.pools.length === 0) {
		ctx.ui.notify("No pools configured.", "info");
		return;
	}

	const options = config.pools.map((p) => `${p.name} -- currently ${p.enabled ? "enabled" : "disabled"}`);

	const selected = await ctx.ui.select("Toggle pool", options);
	if (!selected) return;

	const idx = options.indexOf(selected);
	if (idx < 0) return;

	return togglePoolConfig(ctx, poolManager, config.pools[idx]);
}

async function handlePoolRemove(ctx: ExtensionCommandContext, poolManager: PoolManager): Promise<void> {
	const config = loadGlobalConfig();
	if (config.pools.length === 0) {
		ctx.ui.notify("No pools configured.", "info");
		return;
	}

	const options = config.pools.map((p) => {
		const memberLabel = p.members.length === 1 ? "member" : "members";
		return `${p.name} (${p.members.length} ${memberLabel})`;
	});

	const selected = await ctx.ui.select("Remove pool", options);
	if (!selected) return;

	const idx = options.indexOf(selected);
	if (idx < 0) return;

	await removePoolConfig(ctx, poolManager, config, config.pools[idx]);
}

function summarizePoolHealth(
	pool: PoolConfig,
	authStorage: { hasAuth(provider: string): boolean },
	poolManager: Pick<PoolManager, "getAvailableMembers" | "isMemberExhausted">,
): {
	availableCount: number;
	authedCount: number;
	memberCount: number;
	unavailableCount: number;
	statusLabel: string;
} {
	const availableMembers = pool.enabled ? poolManager.getAvailableMembers(pool, authStorage) : [];
	let authedCount = 0;
	for (const member of pool.members) {
		if (authStorage.hasAuth(member)) authedCount += 1;
	}
	const availableCount = availableMembers.length;
	const memberCount = pool.members.length;
	const unavailableCount = memberCount - availableCount;
	let statusLabel = `${availableCount}/${memberCount} available`;
	if (!pool.enabled) {
		statusLabel += " | pool disabled";
	} else if (memberCount === 0) {
		statusLabel += " | no members configured";
	} else if (availableCount === 0) {
		if (authedCount === 0) {
			statusLabel += " | no auth";
		} else {
			statusLabel += " | cooldown/no eligible members";
		}
	}
	return {
		availableCount,
		authedCount,
		memberCount,
		unavailableCount,
		statusLabel,
	};
}

function formatPoolListDescription(
	pool: PoolConfig,
	authStorage: { hasAuth(provider: string): boolean },
	poolManager: Pick<PoolManager, "getAvailableMembers" | "isMemberExhausted">,
): string {
	const summary = summarizePoolHealth(pool, authStorage, poolManager);
	const status = pool.enabled ? "enabled" : "disabled";
	return `${pool.baseProvider} | ${summary.memberCount} member${summary.memberCount === 1 ? "" : "s"} (${summary.authedCount} authed, ${summary.availableCount} available) | ${status}${summary.unavailableCount > 0 ? ` | ${summary.unavailableCount} unavailable` : ""}`;
}

function formatPoolStatusLines(
	pool: PoolConfig,
	authStorage: { hasAuth(provider: string): boolean },
	poolManager: Pick<PoolManager, "getAvailableMembers" | "isMemberExhausted">,
): string[] {
	const summary = summarizePoolHealth(pool, authStorage, poolManager);
	const strategy = pool.strategy || "round-robin";
	const lines = [
		`=== ${pool.name} (${pool.enabled ? "enabled" : "disabled"}) ===`,
		`provider: ${pool.name}`,
		`models: ${getSelectableModelsForPool(pool).length}`,
		`strategy: ${strategy}`,
		`members: ${summary.memberCount}`,
		`availability: ${summary.statusLabel}`,
	];
	if (pool.selectorScript) {
		lines.push(`selector: ${pool.selectorScript}`);
	}
	if (pool.members.length === 0) {
		lines.push("  [no members configured]");
		return lines;
	}
	const memberSchedule = pool.memberSchedule || {};
	const shared = getSharedPoolState().snapshot();
	const identities = new Map<string, Member>();
	for (const member of pool.members) {
		try {
			identities.set(member, getMember(member));
		} catch {
			lines.push(`  ${member} -- invalid credential; use /subs login`);
		}
	}
	const memberKeys = new Set([...identities.values()].map((member) => member.key));
	const waiting = Object.values(shared.waiters ?? {}).filter((request) =>
		request.keys.some((key) => memberKeys.has(key)),
	).length;
	lines.push(`waiting requests: ${waiting}`);
	const limit = loadGlobalConfig().maxConcurrentPerAccount ?? 2;
	for (const member of pool.members) {
		const identity = identities.get(member);
		if (!identity) continue;
		const authed = authStorage.hasAuth(member);
		const exhausted = pool.enabled && authed && poolManager.isMemberExhausted(pool, member);
		let status = authed ? "logged in" : "not logged in";
		if (exhausted) status += " (rate limited, cooling down)";
		if (pool.enabled && authed && !exhausted) status += " (available)";
		if (!pool.enabled && authed) status += " (pool disabled)";

		const schedule = memberSchedule[member];
		if (schedule) {
			const role = schedule.role || "default";
			status += ` [${role}]`;
			if (schedule.windows && schedule.windows.length > 0) {
				const now = new Date();
				const state = getScheduledMemberState(member, schedule, now);
				status += state.active ? " (in window)" : " (outside window)";
			}
		}

		const key = identity.key;
		const account = shared.accounts[key];
		lines.push(`  ${member} -- ${status} | requests ${activeRequests(shared, key)}/${limit}`);
		if (account?.quota) {
			lines.push(`    quota: ${account.quota.summary} | checked ${new Date(account.quota.checkedAt).toISOString()}`);
			if (account.quota.kind === "error" && account.lastSuccessfulCheckAt) {
				lines.push(`    last successful quota check: ${new Date(account.lastSuccessfulCheckAt).toISOString()}`);
			}
		} else {
			lines.push("    quota: unknown (use /subs limits)");
		}
		if (account?.cooldownUntil && account.cooldownUntil > Date.now()) {
			lines.push(`    request cooldown until ${new Date(account.cooldownUntil).toISOString()}`);
		}
		if (account?.blockedUntil && account.blockedUntil > Date.now()) {
			lines.push(`    quota unavailable until ${new Date(account.blockedUntil).toISOString()}`);
		}
		if (account?.failure) lines.push(`    last rejection: ${account.failure}`);
	}
	return lines;
}

async function handlePoolStatus(ctx: ExtensionCommandContext, poolManager: PoolManager): Promise<void> {
	const config = loadGlobalConfig();
	if (config.pools.length === 0) {
		ctx.ui.notify("No pools configured.", "info");
		return;
	}

	const lines: string[] = [];
	for (const pool of config.pools) {
		lines.push(...formatPoolStatusLines(pool, getAuthStorage(ctx), poolManager));
	}

	await ctx.ui.select("Pool Status", lines);
}

function findChainByName(chains: ChainConfig[], name: string): ChainConfig | undefined {
	return chains.find((chain) => chain.name === name);
}

function getChainEntryIssue(entry: ChainEntryConfig, config: MultiPassConfig): string | null {
	const pool = config.pools.find((candidate) => candidate.name === entry.pool);
	if (!pool) {
		return `invalid pool: ${entry.pool} missing`;
	}
	if (!pool.enabled) {
		return `invalid pool: ${pool.name} disabled`;
	}
	const selectableModels = getSelectableModelsForPool(pool);
	if (selectableModels.length === 0) {
		return `invalid model: no selectable models for ${pool.baseProvider}`;
	}
	if (!selectableModels.includes(entry.model)) {
		return `invalid model: ${entry.model} unavailable for ${pool.name}`;
	}
	return null;
}

function formatChainEntryStatus(
	entry: ChainEntryConfig,
	config?: MultiPassConfig,
	authStorage?: { hasAuth(provider: string): boolean },
	poolManager?: Pick<PoolManager, "getAvailableMembers" | "isMemberExhausted">,
): string {
	const entryState = entry.enabled ? "enabled" : "disabled";
	const issue = config ? getChainEntryIssue(entry, config) : null;
	let healthSuffix = "";
	if (config && authStorage && poolManager) {
		const pool = config.pools.find((candidate) => candidate.name === entry.pool);
		if (pool) {
			const summary = summarizePoolHealth(pool, authStorage, poolManager);
			healthSuffix = ` | pool ${pool.enabled ? "enabled" : "disabled"} | ${summary.availableCount}/${summary.memberCount} available | ${summary.authedCount} authed`;
		}
	}
	const issueSuffix = issue ? ` | ${issue} | skipped` : "";
	return `${entry.pool} -> ${entry.model} (${entryState}${healthSuffix}${issueSuffix})`;
}

function formatChainListLine(
	chain: ChainConfig,
	config?: MultiPassConfig,
	authStorage?: { hasAuth(provider: string): boolean },
	poolManager?: Pick<PoolManager, "getAvailableMembers" | "isMemberExhausted">,
): string {
	const entryLabel = chain.entries.length === 1 ? "entry" : "entries";
	const invalidEntries = config ? chain.entries.filter((entry) => getChainEntryIssue(entry, config)).length : 0;
	let usableEntries = 0;
	if (config && authStorage && poolManager) {
		usableEntries = chain.entries.filter((entry) => {
			if (!entry.enabled) return false;
			if (getChainEntryIssue(entry, config)) return false;
			const pool = config.pools.find((candidate) => candidate.name === entry.pool);
			if (!pool?.enabled) return false;
			return summarizePoolHealth(pool, authStorage, poolManager).availableCount > 0;
		}).length;
	}
	const issueLabel = invalidEntries > 0 ? ` | ${invalidEntries} invalid` : "";
	const usableLabel =
		config && authStorage && poolManager ? ` | ${usableEntries}/${chain.entries.length} usable now` : "";
	return `${chain.name} | ${chain.entries.length} ${entryLabel} | ${chain.enabled ? "enabled" : "disabled"}${issueLabel}${usableLabel}`;
}

function formatChainToggleOption(chain: ChainConfig): string {
	return `${chain.name} -- currently ${chain.enabled ? "enabled" : "disabled"}`;
}

function formatChainRemoveOption(chain: ChainConfig): string {
	const entryLabel = chain.entries.length === 1 ? "entry" : "entries";
	return `${chain.name} (${chain.entries.length} ${entryLabel})`;
}

function formatChainStatusLines(
	chain: ChainConfig,
	config?: MultiPassConfig,
	authStorage?: { hasAuth(provider: string): boolean },
	poolManager?: Pick<PoolManager, "getAvailableMembers" | "isMemberExhausted">,
): string[] {
	const invalidEntries = config ? chain.entries.filter((entry) => getChainEntryIssue(entry, config)).length : 0;
	const usableEntries =
		config && authStorage && poolManager
			? chain.entries.filter((entry) => {
					if (!entry.enabled) return false;
					if (getChainEntryIssue(entry, config)) return false;
					const pool = config.pools.find((candidate) => candidate.name === entry.pool);
					if (!pool?.enabled) return false;
					return summarizePoolHealth(pool, authStorage, poolManager).availableCount > 0;
				}).length
			: undefined;
	const lines = [
		`=== ${chain.name} (${chain.enabled ? "enabled" : "disabled"}) ===`,
		`entries: ${chain.entries.length}`,
		`chain state: ${chain.enabled ? "active" : "disabled (all entries skipped)"}`,
	];

	if (usableEntries !== undefined) {
		lines.push(`usable entries now: ${usableEntries}/${chain.entries.length}`);
	}

	if (invalidEntries > 0) {
		lines.push(`invalid entries: ${invalidEntries} (skipped until fixed)`);
	}

	if (chain.entries.length === 0) {
		lines.push("  [no entries configured]");
		return lines;
	}

	for (let i = 0; i < chain.entries.length; i++) {
		const entry = chain.entries[i];
		lines.push(`  ${i + 1}. ${formatChainEntryStatus(entry, config, authStorage, poolManager)}`);
	}

	return lines;
}

async function handlePoolChainCreate(ctx: ExtensionCommandContext, poolManager: PoolManager): Promise<void> {
	const config = loadGlobalConfig();
	const chainName = await ctx.ui.input("Chain name", "e.g. primary-fallback");
	if (!chainName?.trim()) return;
	if (findChainByName(config.chains, chainName.trim())) {
		ctx.ui.notify(`Chain "${chainName.trim()}" already exists.`, "warning");
		return;
	}

	const entries: ChainEntryConfig[] = [];
	let selecting = true;
	while (selecting) {
		const latestConfig = loadGlobalConfig();
		const availablePools = latestConfig.pools;
		const poolItems: SelectItem[] = [
			{
				value: "__summary__",
				label: `Selected (${entries.length})`,
				description: entries.map((entry) => formatChainEntryStatus(entry, latestConfig)).join(", ") || "none",
			},
			...availablePools.map((pool) => ({
				value: `pool:${pool.name}`,
				label: pool.name,
				description: `${pool.baseProvider} (${pool.enabled ? "enabled" : "disabled"})`,
			})),
			{ value: "__create_pool__", label: "Create pool inline" },
			{ value: "__done__", label: "Done - save chain" },
		];

		const selected = await showWrappedSelect(ctx, {
			title: "Add chain entries",
			subtitle: "Done saves the chain; Escape cancels.",
			items: poolItems,
			confirmHint: "select",
			cancelHint: "cancel",
		});
		if (!selected) {
			ctx.ui.notify(`Cancelled chain creation for "${chainName.trim()}".`, "info");
			return;
		}
		if (selected === "__summary__") continue;

		if (selected === "__done__") {
			if (entries.length === 0) {
				ctx.ui.notify(`Chain "${chainName.trim()}" needs at least 1 entry.`, "warning");
				continue;
			}
			selecting = false;
			continue;
		}

		if (selected === "__create_pool__") {
			await createAndPersistPool(ctx, poolManager, {
				allowOverwrite: false,
				resumeChainName: chainName.trim(),
			});
			continue;
		}

		const pool = availablePools.find((candidate) => `pool:${candidate.name}` === selected);
		if (!pool) {
			ctx.ui.notify(`Pool "${selected}" is no longer available.`, "warning");
			continue;
		}

		const selectableModels = getSelectableModelsForPool(pool);
		if (selectableModels.length === 0) {
			ctx.ui.notify(`Pool "${pool.name}" has no selectable models for ${pool.baseProvider}.`, "warning");
			continue;
		}

		const selectedModel = await ctx.ui.select(`Default model for ${pool.name}`, selectableModels);
		if (!selectedModel) continue;

		const enabled = await ctx.ui.confirm(
			`Enable entry for ${pool.name}?`,
			`${pool.name} -> ${selectedModel}\n\nEnable this chain entry?`,
		);
		entries.push({ pool: pool.name, model: selectedModel, enabled });
	}

	const latestConfig = loadGlobalConfig();
	const built = buildChainConfig(latestConfig, {
		name: chainName.trim(),
		entries,
		enabled: true,
	});
	if (!built.ok) {
		ctx.ui.notify(built.error, "warning");
		return;
	}

	updateGlobalConfig((latest) => {
		const issue = createChainValidationError(latest, built.chain);
		if (issue) throw new Error(issue);
		latest.chains.push(built.chain);
	});
	ctx.ui.notify(
		`Created chain "${built.chain.name}" with ${built.chain.entries.length} ${built.chain.entries.length === 1 ? "entry" : "entries"}.`,
		"info",
	);
}

async function handlePoolChainList(ctx: ExtensionCommandContext, poolManager: PoolManager): Promise<void> {
	const config = loadGlobalConfig();
	if (config.chains.length === 0) {
		ctx.ui.notify("No chains configured. Use /pool chain to create one.", "info");
		return;
	}

	await ctx.ui.select(
		"Chains",
		config.chains.map((chain) => formatChainListLine(chain, config, getAuthStorage(ctx), poolManager)),
	);
}

async function handlePoolChainToggle(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	if (config.chains.length === 0) {
		ctx.ui.notify("No chains configured.", "info");
		return;
	}

	const options = config.chains.map(formatChainToggleOption);
	const selected = await ctx.ui.select("Toggle chain", options);
	if (!selected) return;

	const idx = options.indexOf(selected);
	if (idx < 0) return;

	const chain = updateGlobalConfig((latest) => {
		const target = requireNamed(latest.chains, config.chains[idx].name);
		target.enabled = !target.enabled;
		return target;
	});
	ctx.ui.notify(`Chain "${chain.name}" is now ${chain.enabled ? "enabled" : "disabled"}`, "info");
}

async function handlePoolChainRemove(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	if (config.chains.length === 0) {
		ctx.ui.notify("No chains configured.", "info");
		return;
	}

	const options = config.chains.map(formatChainRemoveOption);
	const selected = await ctx.ui.select("Remove chain", options);
	if (!selected) return;

	const idx = options.indexOf(selected);
	if (idx < 0) return;

	const chain = config.chains[idx];
	const confirmed = await ctx.ui.confirm("Confirm removal", `Remove chain "${chain.name}"?`);
	if (!confirmed) return;

	updateGlobalConfig((latest) => {
		latest.chains = latest.chains.filter((candidate) => candidate.name !== chain.name);
	});
	ctx.ui.notify(`Removed chain "${chain.name}"`, "info");
}

async function handlePoolChainStatus(ctx: ExtensionCommandContext, poolManager: PoolManager): Promise<void> {
	const config = loadGlobalConfig();
	if (config.chains.length === 0) {
		ctx.ui.notify("No chains configured.", "info");
		return;
	}

	const selected = await showWrappedSelect(ctx, {
		title: "Chain Status",
		items: config.chains.map((chain) => ({
			value: chain.name,
			label: chain.name,
			description: "inspect chain entries",
		})),
		confirmHint: "inspect",
		cancelHint: "back",
	});
	if (!selected) return;

	const chain = findChainByName(config.chains, selected);
	if (!chain) {
		ctx.ui.notify(`Chain "${selected}" not found.`, "warning");
		return;
	}

	await ctx.ui.select(
		`Chain Status: ${chain.name}`,
		formatChainStatusLines(chain, config, getAuthStorage(ctx), poolManager),
	);
}

async function handlePoolChainMenu(ctx: ExtensionCommandContext, poolManager: PoolManager): Promise<void> {
	const actions = [
		"create   -- Create a new fallback chain",
		"list     -- Show all chains",
		"toggle   -- Enable/disable a chain",
		"remove   -- Remove a chain",
		"status   -- Inspect ordered chain entries",
	];

	const selected = await ctx.ui.select("Chain Manager", actions);
	if (!selected) return;

	const action = selected.split(" ")[0].trim();
	switch (action) {
		case "create":
			return handlePoolChainCreate(ctx, poolManager);
		case "list":
			return handlePoolChainList(ctx, poolManager);
		case "toggle":
			return handlePoolChainToggle(ctx);
		case "remove":
			return handlePoolChainRemove(ctx);
		case "status":
			return handlePoolChainStatus(ctx, poolManager);
	}
}

async function handlePoolProject(ctx: ExtensionCommandContext, poolManager: PoolManager): Promise<void> {
	const projectPath = projectConfigPath(ctx.cwd);
	const projectConf = loadProjectConfig(ctx.cwd);
	const globalConf = loadGlobalConfig();

	const hasProjectConfig = projectConf !== undefined;

	const actions: string[] = [`edit     -- Edit project pool config (${projectPath})`];
	if (hasProjectConfig) {
		actions.push("clear    -- Remove project config (use global pools)");
	}
	actions.push("restrict -- Set allowed subs for this project");
	actions.push("pools    -- Select global pools by name");
	actions.push("info     -- Show effective config for this project");

	const selected = await ctx.ui.select(`Project Config (${hasProjectConfig ? "active" : "none"})`, actions);
	if (!selected) return;

	const action = selected.split(" ")[0].trim();

	if (action === "edit") {
		const source = await ctx.ui.editor("Project pool configuration", JSON.stringify(projectConf ?? {}, null, 2));
		if (source === undefined) return;
		const next = normalizeProjectConfig(JSON.parse(source));
		updateProjectConfig(ctx.cwd, (latest) => {
			if (!isDeepStrictEqual(latest, projectConf ?? {}))
				throw new Error("Project configuration changed while editing; reopen the editor");
			for (const key of Object.keys(latest)) delete latest[key as keyof ProjectConfig];
			Object.assign(latest, next);
		});
		reloadPoolManagerForCurrentProject(ctx, poolManager);
		ctx.ui.notify("Project configuration saved.", "info");
		return;
	}

	if (action === "clear") {
		if (!hasProjectConfig) {
			ctx.ui.notify("No project config to clear.", "info");
			return;
		}
		const confirmed = await ctx.ui.confirm(
			"Clear project config",
			`Remove ${projectPath}?\nGlobal pools will be used instead.`,
		);
		if (!confirmed) return;
		try {
			updateProjectConfig(ctx.cwd, (latest) => {
				for (const key of Object.keys(latest)) delete latest[key as keyof ProjectConfig];
			});
			const effective = loadEffectiveConfig(ctx.cwd);
			poolManager.loadPools(effective.pools);
			ctx.ui.notify("Project config cleared. Using global pools.", "info");
		} catch (err: unknown) {
			ctx.ui.notify(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
		return;
	}

	if (action === "restrict") {
		// Show all global subs and let user pick which are allowed
		const envEntries = parseEnvConfig();
		const allSubs = mergeConfigs(globalConf, envEntries);
		const allProviderNames = [
			...SUPPORTED_PROVIDERS.filter((p) => getAuthStorage(ctx).hasAuth(p)),
			...allSubs.map((s) => subProviderName(s)),
		];

		if (allProviderNames.length === 0) {
			ctx.ui.notify("No subscriptions available to restrict.", "info");
			return;
		}

		const currentAllowed = projectConf?.allowedSubs || [];
		const allowed: string[] = [];
		let selecting = true;

		while (selecting) {
			const remaining = allProviderNames.filter((p) => !allowed.includes(p));
			if (remaining.length === 0) break;

			const options = [
				`--- Allowed (${allowed.length}): ${allowed.join(", ") || "all (no restriction)"} ---`,
				...remaining.map((p) => {
					const authed = getAuthStorage(ctx).hasAuth(p);
					const current = currentAllowed.includes(p) ? " [currently allowed]" : "";
					return `${p} ${authed ? "[logged in]" : "[not logged in]"}${current}`;
				}),
				"[Done - save]",
				"[Clear - allow all]",
			];

			const picked = await ctx.ui.select("Select allowed subs (Esc when done)", options);
			if (!picked) return;
			if (picked.startsWith("---")) continue;
			if (picked === "[Done - save]") {
				selecting = false;
				continue;
			}
			if (picked === "[Clear - allow all]") {
				allowed.length = 0;
				selecting = false;
				continue;
			}

			const provName = picked.split(" ")[0];
			if (provName && allProviderNames.includes(provName)) {
				allowed.push(provName);
			}
		}

		updateProjectConfig(ctx.cwd, (latest) => {
			latest.allowedSubs = allowed.length > 0 ? allowed : undefined;
		});

		const effective = loadEffectiveConfig(ctx.cwd);
		poolManager.loadPools(effective.pools);

		if (allowed.length > 0) {
			ctx.ui.notify(`Project restricted to: ${allowed.join(", ")}`, "info");
		} else {
			ctx.ui.notify("Project restriction cleared. All subs available.", "info");
		}
		return;
	}

	if (action === "pools") {
		// Named references follow global edits; explicit project definitions remain independent.
		const globalPools = globalConf.pools;
		if (globalPools.length === 0) {
			ctx.ui.notify("No global pools defined. Create pools first with /pool create.", "info");
			return;
		}

		const currentProjectPools = projectConf?.pools;
		const selected2 = await showWrappedSelect(ctx, {
			title: "Project pools",
			subtitle: "Select a pool to toggle it.",
			items: [
				{ value: "__global__", label: "Use global pools (no override)" },
				...globalPools.map((pool) => ({
					value: `pool:${pool.name}`,
					label: pool.name,
					description: `${pool.members.length} members ${
						currentProjectPools
							? currentProjectPools.some((entry) => (typeof entry === "string" ? entry : entry.name) === pool.name)
								? "[included]"
								: "[excluded]"
							: "[included]"
					}`,
				})),
			],
			confirmHint: "toggle",
			cancelHint: "back",
		});
		if (!selected2) return;

		if (selected2 === "__global__") {
			updateProjectConfig(ctx.cwd, (latest) => {
				delete latest.pools;
			});
			const effective = loadEffectiveConfig(ctx.cwd);
			poolManager.loadPools(effective.pools);
			ctx.ui.notify("Project will use global pools.", "info");
			return;
		}

		// Toggle: build project pool list
		const pool = globalPools.find((candidate) => `pool:${candidate.name}` === selected2);
		if (!pool) return;

		const projectPools = updateProjectConfig(ctx.cwd, (latest) => {
			const currentGlobalPools = loadGlobalConfig().pools;
			const pools = latest.pools ?? currentGlobalPools.map((candidate) => candidate.name);
			const index = pools.findIndex(
				(candidate) => (typeof candidate === "string" ? candidate : candidate.name) === pool.name,
			);
			if (index >= 0) pools.splice(index, 1);
			else {
				requireNamed(currentGlobalPools, pool.name);
				pools.push(pool.name);
			}
			latest.pools = pools;
			return pools;
		});
		const effective = loadEffectiveConfig(ctx.cwd);
		poolManager.loadPools(effective.pools);

		const activeNames = projectPools.map((p) => (typeof p === "string" ? p : p.name)).join(", ") || "none";
		ctx.ui.notify(`Project pools: ${activeNames}`, "info");
		return;
	}

	if (action === "info") {
		const effective = loadEffectiveConfig(ctx.cwd);
		const lines: string[] = [];

		if (effective.projectConfigPath && loadProjectConfig(ctx.cwd)) {
			lines.push(`Project config: ${projectPath}`);
		} else {
			lines.push("Project config: none (using global)");
		}

		const pc = loadProjectConfig(ctx.cwd);
		if (pc?.allowedSubs && pc.allowedSubs.length > 0) {
			lines.push(`Allowed subs: ${pc.allowedSubs.join(", ")}`);
		} else {
			lines.push("Allowed subs: all (no restriction)");
		}

		lines.push("");
		lines.push(`Effective pools (${effective.pools.length}):`);
		for (const pool of effective.pools) {
			const src = pc?.pools?.some((entry) => typeof entry !== "string" && entry.name === pool.name)
				? "project"
				: "global";
			lines.push(`  ${pool.name} [${src}] -- ${pool.members.join(", ")} (${pool.enabled ? "enabled" : "disabled"})`);
		}

		lines.push("");
		lines.push(`Effective subs (${effective.subscriptions.length}):`);
		for (const sub of effective.subscriptions) {
			const authed = getAuthStorage(ctx).hasAuth(subProviderName(sub));
			lines.push(`  ${subDisplayName(sub)} -- ${authed ? "logged in" : "not logged in"}`);
		}

		await ctx.ui.select("Effective Config", lines);
		return;
	}
}

async function handlePoolMenu(ctx: ExtensionCommandContext, poolManager: PoolManager): Promise<void> {
	const actions = [
		"create   -- Create a new rotation pool",
		"list     -- Show pools and quick actions",
		"chain    -- Manage saved fallback chains",
		"toggle   -- Enable/disable a pool",
		"remove   -- Remove a pool",
		"status   -- Detailed pool status with member health",
		"project  -- Project-level pool config (.pi/multi-pass.json)",
	];

	const selected = await ctx.ui.select("Pool Manager", actions);
	if (!selected) return;

	const action = selected.split(" ")[0].trim();
	switch (action) {
		case "create":
			return handlePoolCreate(ctx, poolManager);
		case "list":
			return handlePoolList(ctx, poolManager);
		case "chain":
			return handlePoolChainMenu(ctx, poolManager);
		case "toggle":
			return handlePoolToggle(ctx, poolManager);
		case "remove":
			return handlePoolRemove(ctx, poolManager);
		case "status":
			return handlePoolStatus(ctx, poolManager);
		case "project":
			return handlePoolProject(ctx, poolManager);
	}
}

// ==========================================================================
// /subs main menu
// ==========================================================================

async function handleSubsMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext, poolManager: PoolManager): Promise<void> {
	const actions: SelectItem[] = [
		{ value: "list", label: "list", description: "Show all extra subscriptions" },
		{ value: "add", label: "add", description: "Add a new subscription" },
		{ value: "remove", label: "remove", description: "Remove a subscription" },
		{ value: "login", label: "login", description: "Login to a subscription" },
		{ value: "logout", label: "logout", description: "Logout from a subscription" },
		{ value: "switch", label: "switch", description: "Switch to a different subscription/provider now" },
		{ value: "status", label: "status", description: "Show auth status and token info" },
		{ value: "limits", label: "limits", description: "Check built-in Codex quota support" },
	];
	let preferredAction = "list";

	while (true) {
		const action = await showWrappedSelect(ctx, {
			title: "Subscription Manager",
			items: actions,
			initialValue: preferredAction,
			confirmHint: "open",
			cancelHint: "close",
		});
		if (!action) return;

		preferredAction = action;
		switch (action) {
			case "list":
				await handleSubsList(pi, ctx, poolManager);
				break;
			case "add":
				await handleSubsAdd(pi, ctx, poolManager);
				break;
			case "remove":
				await handleSubsRemove(pi, ctx, poolManager);
				break;
			case "login":
				await handleSubsLogin(ctx);
				break;
			case "logout":
				await handleSubsLogout(ctx);
				break;
			case "switch":
				await handleSubsSwitch(pi, ctx);
				break;
			case "status":
				await handleSubsStatus(ctx);
				break;
			case "limits":
				await handleSubsLimits(ctx);
				break;
		}
	}
}

// ==========================================================================
// /mp-preset command handlers
// ==========================================================================

/** Pretty-print a preset entry using subscription labels when available. */
function formatPresetEntryWith(entry: PresetEntry, allSubs: SubEntry[]): string {
	const displayName = getProviderDisplayName(entry.provider, allSubs);
	return `${displayName} / ${entry.model}`;
}

async function handlePresetCreate(ctx: ExtensionCommandContext): Promise<void> {
	const presetName = await ctx.ui.input("Preset name", "e.g. coding-premium, coding-budget, fastest");
	if (!presetName?.trim()) return;

	const config = loadGlobalConfig();
	if (config.presets.find((p) => p.name === presetName.trim())) {
		const overwrite = await ctx.ui.confirm("Preset exists", `Overwrite "${presetName.trim()}"?`);
		if (!overwrite) return;
	}

	const envEntries = parseEnvConfig();
	const allSubs = mergeConfigs(config, envEntries);
	const allProviders: string[] = [];
	for (const provider of SUPPORTED_PROVIDERS) {
		allProviders.push(provider);
	}
	for (const entry of allSubs) {
		allProviders.push(subProviderName(entry));
	}
	for (const pool of loadEffectiveConfig(ctx.cwd).pools) {
		if (pool.enabled) allProviders.push(pool.name);
	}

	const entries: PresetEntry[] = [];
	let adding = true;
	while (adding) {
		const picked = await showWrappedSelect(ctx, {
			title: "Add entry",
			subtitle: "Done saves the preset; Escape cancels.",
			items: [
				{
					value: "__summary__",
					label: `Entries (${entries.length})`,
					description: entries.map((entry) => formatPresetEntryWith(entry, allSubs)).join(", ") || "none",
				},
				...allProviders.map((provider) => ({
					value: `provider:${provider}`,
					label: provider,
					description: getProviderDisplayName(provider, allSubs),
				})),
				{ value: "__done__", label: "Done - save preset" },
			],
			confirmHint: "select",
			cancelHint: "cancel",
		});
		if (!picked) return;
		if (picked === "__summary__") continue;
		if (picked === "__done__") {
			if (entries.length === 0) {
				ctx.ui.notify("Add at least one entry.", "warning");
				continue;
			}
			adding = false;
			continue;
		}

		const provider = allProviders.find((candidate) => `provider:${candidate}` === picked);
		if (!provider) continue;
		const pool = loadEffectiveConfig(ctx.cwd).pools.find((candidate) => candidate.name === provider);
		if (!pool && !getBaseProvider(provider)) continue;

		const models = pool ? getSelectableModelsForPool(pool) : getCodexModels().map((m) => m.id);
		if (models.length === 0) {
			ctx.ui.notify(`No models available for ${provider}.`, "warning");
			continue;
		}

		const model = await ctx.ui.select(`Model for ${provider}`, models);
		if (!model) continue;

		entries.push({ provider, model, enabled: true });
	}

	const preset: PresetConfig = {
		name: presetName.trim(),
		entries,
		enabled: true,
	};
	updateGlobalConfig((latest) =>
		replaceNamed(
			latest.presets,
			preset,
			config.presets.find((candidate) => candidate.name === preset.name),
		),
	);
	ctx.ui.notify(
		`Preset "${preset.name}" saved with ${entries.length} ${entries.length === 1 ? "entry" : "entries"}: ${entries.map((e) => formatPresetEntryWith(e, allSubs)).join(", ")}`,
		"info",
	);
}

async function handlePresetList(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	if (config.presets.length === 0) {
		ctx.ui.notify("No presets configured. Use /mp-preset create to add one.", "info");
		return;
	}

	const envEntries = parseEnvConfig();
	const allSubs = mergeConfigs(config, envEntries);
	const items: SelectItem[] = config.presets.map((preset) => ({
		value: preset.name,
		label: `${preset.enabled ? "+" : "-"} ${preset.name}`,
		description: preset.entries.map((e) => formatPresetEntryWith(e, allSubs)).join(" -> "),
	}));

	await showWrappedSelect(ctx, {
		title: "Model Presets",
		subtitle: "Presets are named routing shortcuts across Codex accounts.",
		items,
		confirmHint: "back",
		cancelHint: "close",
	});
}

async function handlePresetActivate(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	requestedName?: string,
): Promise<void> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const allSubs = mergeConfigs(config, envEntries);
	const enabled = config.presets.filter((p) => p.enabled);
	if (enabled.length === 0) {
		ctx.ui.notify("No enabled presets. Use /mp-preset create to add one.", "info");
		return;
	}

	let presetName = requestedName?.trim();
	if (!presetName) {
		presetName = await showWrappedSelect(ctx, {
			title: "Activate Preset",
			subtitle: "Select a preset to switch to its best available entry.",
			items: enabled.map((p) => ({
				value: p.name,
				label: p.name,
				description: p.entries
					.filter((e) => e.enabled)
					.map((e) => formatPresetEntryWith(e, allSubs))
					.join(" -> "),
			})),
			confirmHint: "activate",
			cancelHint: "back",
		});
	}
	if (!presetName) return;

	const preset = enabled.find((p) => p.name === presetName);
	if (!preset) {
		ctx.ui.notify(`Preset "${presetName}" not found.`, "error");
		return;
	}

	for (const entry of preset.entries) {
		if (!entry.enabled) continue;
		if (!getAuthStorage(ctx).hasAuth(entry.provider)) continue;
		const model = ctx.modelRegistry.find(entry.provider, entry.model);
		if (!model) continue;

		const success = await safeSetModel(pi, model);
		if (!success) continue;

		const prettyEntry = formatPresetEntryWith(entry, allSubs);
		ctx.ui.notify(`Preset "${preset.name}": switched to ${prettyEntry}`, "info");
		ctx.ui.setStatus("multi-pass", `preset:${preset.name} | ${prettyEntry}`);
		return;
	}

	ctx.ui.notify(
		`Preset "${preset.name}": no entry has a logged-in provider with the required model available.`,
		"warning",
	);
}

async function handlePresetRemove(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	if (config.presets.length === 0) {
		ctx.ui.notify("No presets to remove.", "info");
		return;
	}

	const selected = await showWrappedSelect(ctx, {
		title: "Remove Preset",
		items: config.presets.map((p) => ({
			value: p.name,
			label: p.name,
			description: `${p.entries.length} entries`,
		})),
		confirmHint: "remove",
		cancelHint: "back",
	});
	if (!selected) return;

	const confirmed = await ctx.ui.confirm("Confirm", `Remove preset "${selected}"?`);
	if (!confirmed) return;

	updateGlobalConfig((latest) => {
		latest.presets = latest.presets.filter((preset) => preset.name !== selected);
	});
	ctx.ui.notify(`Removed preset "${selected}".`, "info");
}

async function handlePresetToggle(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	if (config.presets.length === 0) {
		ctx.ui.notify("No presets configured.", "info");
		return;
	}

	const selected = await showWrappedSelect(ctx, {
		title: "Toggle Preset",
		items: config.presets.map((p) => ({
			value: p.name,
			label: `${p.enabled ? "+" : "-"} ${p.name}`,
			description: p.enabled ? "enabled" : "disabled",
		})),
		confirmHint: "toggle",
		cancelHint: "back",
	});
	if (!selected) return;

	const preset = updateGlobalConfig((latest) => {
		const target = requireNamed(latest.presets, selected);
		target.enabled = !target.enabled;
		return target;
	});
	ctx.ui.notify(`Preset "${preset.name}" is now ${preset.enabled ? "enabled" : "disabled"}.`, "info");
}

async function handlePresetMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const actions: SelectItem[] = [
		{ value: "activate", label: "activate", description: "Switch to a preset's best available entry" },
		{ value: "create", label: "create", description: "Create a new preset" },
		{ value: "list", label: "list", description: "Show all presets" },
		{ value: "toggle", label: "toggle", description: "Enable/disable a preset" },
		{ value: "remove", label: "remove", description: "Delete a preset" },
	];

	let preferredAction = "activate";
	while (true) {
		const action = await showWrappedSelect(ctx, {
			title: "Model Presets",
			items: actions,
			initialValue: preferredAction,
			confirmHint: "open",
			cancelHint: "close",
		});
		if (!action) return;

		preferredAction = action;
		switch (action) {
			case "activate":
				await handlePresetActivate(pi, ctx);
				break;
			case "create":
				await handlePresetCreate(ctx);
				break;
			case "list":
				await handlePresetList(ctx);
				break;
			case "toggle":
				await handlePresetToggle(ctx);
				break;
			case "remove":
				await handlePresetRemove(ctx);
				break;
		}
	}
}

// ==========================================================================
// Extension entry point
// ==========================================================================

export default async function multiSub(pi: ExtensionAPI) {
	accountRuntime = await ModelRuntime.create({ allowModelNetwork: false });
	const poolManager = new PoolManager(pi);
	let sessionStarted = false;
	let removeStatusListener: (() => void) | undefined;
	let removeWarningListener: (() => void) | undefined;
	poolManager.registerAccounts();
	poolManager.loadPools(loadEffectiveConfig(process.cwd()).pools);

	let projectRestrictionSwitchInFlight = false;
	const enforceProjectRestriction = async (ctx: ExtensionContext | ExtensionCommandContext): Promise<boolean> => {
		if (projectRestrictionSwitchInFlight) return true;
		const effective = loadEffectiveConfig(ctx.cwd);
		const allowedSummary = formatAllowedProviderSummary(effective);
		if (!allowedSummary) {
			return true;
		}
		if (
			ctx.model &&
			(effective.allowedProviderNames?.includes(ctx.model.provider) ||
				effective.pools.some((pool) => pool.enabled && pool.name === ctx.model?.provider))
		) {
			return true;
		}

		for (const providerName of getProjectScopedProviderNames(ctx, effective)) {
			const model = findSelectableModelForProvider(ctx, providerName, ctx.model?.id);
			if (!model) continue;

			projectRestrictionSwitchInFlight = true;
			try {
				const success = await safeSetModel(pi, model);
				if (!success) continue;
				const displayName = getProviderDisplayName(providerName, effective.subscriptions);
				ctx.ui.notify(
					`multi-pass: project restricted to ${allowedSummary}; switched to ${displayName} (${model.id}).`,
					"info",
				);
				return true;
			} finally {
				projectRestrictionSwitchInFlight = false;
			}
		}

		const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "the current model";
		ctx.ui.notify(
			`multi-pass: project restricted to ${allowedSummary}, but no authenticated allowed provider can serve ${currentModel}.`,
			"warning",
		);
		return false;
	};

	// On session start, reload pools with project-level config
	pi.on("session_start", async (_event, ctx) => {
		if (!sessionStarted) {
			sharedSessions++;
			sessionStarted = true;
		}
		const effective = loadEffectiveConfig(ctx.cwd);
		poolManager.setContext(ctx);
		removeStatusListener?.();
		removeWarningListener?.();
		removeWarningListener = pi.events.on("multi-pass:warning", (message) => ctx.ui.notify(String(message), "warning"));
		removeStatusListener = pi.events.on("multi-pass:status", (data) => {
			const status = data as RoutingStatus;
			if (status.sessionId !== ctx.sessionManager.getSessionId()) return;
			ctx.ui.setStatus(
				"multi-pass",
				status.status === "waiting"
					? `pool:${status.pool} | waiting for an account (Esc to cancel)`
					: `pool:${status.pool} | active ${status.provider}`,
			);
		});

		const statusParts: string[] = [];
		const enabledChains = effective.chains.filter((chain) => chain.enabled);
		const activeChain = enabledChains[0];
		if (activeChain) {
			const firstEnabledEntry = activeChain.entries.find((entry) => entry.enabled);
			if (firstEnabledEntry) {
				statusParts.push(`chain:${activeChain.name} | starts ${firstEnabledEntry.pool} -> ${firstEnabledEntry.model}`);
			}
		}
		const allowedSummary = formatAllowedProviderSummary(effective);
		if (allowedSummary) {
			statusParts.push(`allowed ${allowedSummary}`);
		} else {
			const poolCount = effective.pools.filter((p) => p.enabled).length;
			if (poolCount > 0 && !activeChain) {
				statusParts.push(`${poolCount} pool(s)`);
			}
		}
		if (statusParts.length > 0) {
			ctx.ui.setStatus("multi-pass", statusParts.join(" | "));
		}

		await enforceProjectRestriction(ctx);
	});

	pi.on("session_shutdown", async () => {
		removeStatusListener?.();
		removeStatusListener = undefined;
		removeWarningListener?.();
		removeWarningListener = undefined;
		if (!sessionStarted) return;
		sessionStarted = false;
		sharedSessions--;
		if (sharedSessions === 0 && sharedPoolState) {
			sharedPoolState.close();
			sharedPoolState = undefined;
		}
	});

	pi.on("model_select", async (_event, ctx) => {
		await enforceProjectRestriction(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (event.text.trimStart().startsWith("/")) {
			return { action: "continue" as const };
		}
		const ok = await enforceProjectRestriction(ctx);
		if (!ok) return { action: "handled" as const };

		return { action: "continue" as const };
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		poolManager.setContext(ctx);
	});

	// Register /subs command
	pi.registerCommand("subs", {
		description: "Manage extra OAuth subscriptions",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["list", "add", "remove", "login", "logout", "switch", "status", "limits"];
			const filtered = subcommands.filter((s) => s.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = (parts[0] || "").toLowerCase();
			const rest = parts.slice(1).join(" ");
			switch (subcommand) {
				case "list":
				case "ls":
					return handleSubsList(pi, ctx, poolManager);
				case "add":
				case "new":
					return handleSubsAdd(pi, ctx, poolManager);
				case "remove":
				case "rm":
				case "delete":
					return handleSubsRemove(pi, ctx, poolManager);
				case "login":
					return handleSubsLogin(ctx);
				case "logout":
					return handleSubsLogout(ctx);
				case "switch":
					return handleSubsSwitch(pi, ctx, rest || undefined);
				case "status":
				case "info":
					return handleSubsStatus(ctx);
				case "limits":
				case "quota":
				case "usage":
					return handleSubsLimits(ctx);
				default:
					return handleSubsMenu(pi, ctx, poolManager);
			}
		},
	});

	// Register /pool command
	pi.registerCommand("pool", {
		description: "Manage subscription rotation pools",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = [
				"create",
				"list",
				"chain",
				"toggle",
				"remove",
				"status",
				"project",
				"concurrency",
				"models",
				"limits",
			];
			const filtered = subcommands.filter((s) => s.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = (parts[0] || "").toLowerCase();
			const chainSubcommand = (parts[1] || "").toLowerCase();
			switch (subcommand) {
				case "create":
				case "new":
					return handlePoolCreate(ctx, poolManager);
				case "list":
				case "ls":
					return handlePoolList(ctx, poolManager);
				case "chain":
					switch (chainSubcommand) {
						case "":
							return handlePoolChainMenu(ctx, poolManager);
						case "list":
						case "ls":
							return handlePoolChainList(ctx, poolManager);
						case "toggle":
							return handlePoolChainToggle(ctx);
						case "remove":
						case "rm":
						case "delete":
							return handlePoolChainRemove(ctx);
						case "status":
						case "info":
							return handlePoolChainStatus(ctx, poolManager);
						case "create":
						case "new":
							return handlePoolChainCreate(ctx, poolManager);
						default:
							return handlePoolChainMenu(ctx, poolManager);
					}
				case "toggle":
					return handlePoolToggle(ctx, poolManager);
				case "remove":
				case "rm":
				case "delete":
					return handlePoolRemove(ctx, poolManager);
				case "status":
				case "info":
					return handlePoolStatus(ctx, poolManager);
				case "limits":
					return handleSubsLimits(ctx);
				case "models": {
					const pools = loadEffectiveConfig(ctx.cwd).pools.filter((pool) => pool.enabled);
					const name =
						parts.slice(1).join(" ") ||
						(await ctx.ui.select(
							"Pool",
							pools.map((pool) => pool.name),
						));
					const pool = pools.find((candidate) => candidate.name === name);
					if (pool) await poolManager.selectModel(ctx, pool);
					return;
				}
				case "concurrency": {
					const current = loadGlobalConfig();
					if (parts.length === 1) {
						ctx.ui.notify(
							`Per-account concurrency: ${current.maxConcurrentPerAccount ?? 2}. Set with /pool concurrency <number>.`,
							"info",
						);
						return;
					}
					const limit = Number(parts[1]);
					if (parts.length !== 2 || !Number.isSafeInteger(limit) || limit < 1) {
						ctx.ui.notify("Concurrency must be a positive integer.", "error");
						return;
					}
					updateGlobalConfig((config) => {
						config.maxConcurrentPerAccount = limit;
					});
					ctx.ui.notify(`Per-account concurrency is now ${limit} across Pi sessions.`, "info");
					return;
				}
				case "project":
					return handlePoolProject(ctx, poolManager);
				default:
					return handlePoolMenu(ctx, poolManager);
			}
		},
	});

	// Register /mp-preset command (namespaced to avoid collision with pi's built-in /preset)
	pi.registerCommand("mp-preset", {
		description: "Manage multi-pass model presets (named routing shortcuts across Codex accounts)",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["activate", "create", "list", "toggle", "remove"];
			const filtered = subcommands.filter((s) => s.startsWith(prefix));
			if (filtered.length > 0) {
				return filtered.map((s) => ({ value: s, label: s }));
			}
			// Also complete preset names for quick activation
			const config = loadGlobalConfig();
			const presetNames = config.presets
				.filter((p) => p.enabled && p.name.startsWith(prefix))
				.map((p) => ({ value: p.name, label: p.name }));
			return presetNames.length > 0 ? presetNames : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = (parts[0] || "").toLowerCase();
			const rest = parts.slice(1).join(" ");
			switch (subcommand) {
				case "activate":
				case "use":
					return handlePresetActivate(pi, ctx, rest || undefined);
				case "create":
				case "new":
					return handlePresetCreate(ctx);
				case "list":
				case "ls":
					return handlePresetList(ctx);
				case "toggle":
					return handlePresetToggle(ctx);
				case "remove":
				case "rm":
				case "delete":
					return handlePresetRemove(ctx);
				default:
					// If the argument matches a preset name, activate it directly
					if (subcommand) {
						const config = loadGlobalConfig();
						const preset = config.presets.find((p) => p.name.toLowerCase() === subcommand && p.enabled);
						if (preset) {
							return handlePresetActivate(pi, ctx, preset.name);
						}
					}
					return handlePresetMenu(pi, ctx);
			}
		},
	});
}
