import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { record } from "./limits.mts";
import type { SharedPoolState } from "./shared-state.mts";

export interface SubEntry {
	provider: string;
	index: number;
	label?: string;
}

export type PoolStrategy = "round-robin" | "quota-first" | "scheduled" | "custom";
export type DayOfWeek = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export const ALL_DAYS: readonly DayOfWeek[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export interface ScheduleWindow {
	/** Local hours [start, end), wrapping midnight when start > end. */
	hours?: [number, number];
	days?: DayOfWeek[];
	/** Inclusive ISO dates. */
	dateRange?: { from?: string; to?: string };
}

export interface MemberSchedule {
	windows?: ScheduleWindow[];
	/** Preferred members are skipped outside their windows; overflow members are tried last. */
	role?: "preferred" | "overflow";
}

export interface PoolConfig {
	name: string;
	baseProvider: string;
	members: string[];
	enabled: boolean;
	strategy?: PoolStrategy;
	memberSchedule?: Record<string, MemberSchedule>;
	/** Executable module path, accepted only in global configuration. */
	selectorScript?: string;
}

export interface ChainEntryConfig {
	pool: string;
	model: string;
	enabled: boolean;
}
export interface ChainConfig {
	name: string;
	entries: ChainEntryConfig[];
	enabled: boolean;
}
export interface PresetEntry {
	provider: string;
	model: string;
	enabled: boolean;
}
export interface PresetConfig {
	name: string;
	entries: PresetEntry[];
	enabled: boolean;
}
export interface MultiPassConfig {
	subscriptions: SubEntry[];
	pools: PoolConfig[];
	chains: ChainConfig[];
	presets: PresetConfig[];
	maxRetries?: number;
	maxConcurrentPerAccount?: number;
	/** Deleted provider names are never reassigned to another subscription. */
	nextSubscriptionIndex?: number;
}
export interface ProjectConfig {
	/** Global pool names or independent project pool definitions. */
	pools?: (string | PoolConfig)[];
	chains?: ChainConfig[];
	allowedSubs?: string[];
}
export interface EffectiveConfig extends MultiPassConfig {
	allowedProviderNames?: string[];
	projectConfigPath?: string;
}

export function isCodexProviderName(value: unknown): value is string {
	return typeof value === "string" && /^(?:openai-codex|openai-codex-[2-9]\d*|openai-codex-1\d+)$/.test(value);
}

function text(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function array(value: unknown, field: string): unknown[] {
	if (value === undefined) return [];
	assert(Array.isArray(value), `${field} must be an array`);
	return value;
}

function unique(values: string[], field: string): void {
	assert(new Set(values).size === values.length, `${field} contains duplicate names`);
}

function validateSchedules(value: unknown): void {
	if (value === undefined) return;
	const schedules = record(value);
	assert(schedules, "memberSchedule must be an object");
	for (const [provider, raw] of Object.entries(schedules)) {
		assert(isCodexProviderName(provider), `Invalid scheduled account: ${provider}`);
		const schedule = record(raw);
		assert(schedule, `Invalid schedule for ${provider}`);
		assert(
			schedule.role === undefined || schedule.role === "preferred" || schedule.role === "overflow",
			"Invalid schedule role",
		);
		for (const rawWindow of array(schedule.windows, "windows")) {
			const window = record(rawWindow);
			assert(window, "Schedule window must be an object");
			if (window.hours !== undefined) {
				assert(
					Array.isArray(window.hours) &&
						window.hours.length === 2 &&
						window.hours.every((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23),
					"Invalid schedule hours",
				);
			}
			if (window.days !== undefined) {
				assert(
					Array.isArray(window.days) && window.days.every((day) => ALL_DAYS.includes(day)),
					"Invalid schedule days",
				);
			}
			if (window.dateRange !== undefined) {
				const range = record(window.dateRange);
				assert(range, "dateRange must be an object");
				for (const date of [range.from, range.to])
					assert(date === undefined || validDate(date), "Invalid schedule date");
				assert(!range.from || !range.to || String(range.from) <= String(range.to), "Schedule date range is reversed");
			}
		}
	}
}

export function validDate(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizePools(value: unknown): PoolConfig[] {
	const pools = array(value, "pools").map((raw) => {
		const pool = record(raw);
		assert(pool && text(pool.name), "Pool name is required");
		assert(
			pool.name === pool.name.trim() &&
				!/[/:\\]/u.test(pool.name) &&
				[...pool.name].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
			"Invalid pool name",
		);
		assert(pool.baseProvider === "openai-codex", "Pool baseProvider must be openai-codex");
		assert(
			Array.isArray(pool.members) && pool.members.length > 0 && pool.members.every(isCodexProviderName),
			`Invalid members for pool ${pool.name}`,
		);
		unique(pool.members, `Pool ${pool.name}`);
		assert(typeof pool.enabled === "boolean", `Pool ${pool.name} needs an enabled flag`);
		assert(
			pool.strategy === undefined ||
				["round-robin", "quota-first", "scheduled", "custom"].includes(String(pool.strategy)),
			"Invalid pool strategy",
		);
		assert(pool.selectorScript === undefined || text(pool.selectorScript), "Invalid selectorScript");
		validateSchedules(pool.memberSchedule);
		return { ...pool, members: [...pool.members] } as unknown as PoolConfig;
	});
	unique(
		pools.map((pool) => pool.name),
		"pools",
	);
	return pools;
}

function normalizeRoutes(value: unknown, field: "chains" | "presets"): ChainConfig[] | PresetConfig[] {
	const routes = array(value, field);
	for (const raw of routes) {
		const route = record(raw);
		assert(route && text(route.name) && typeof route.enabled === "boolean", `Invalid ${field} entry`);
		assert(Array.isArray(route.entries) && route.entries.length > 0, `${field} entries must be nonempty`);
		for (const rawEntry of route.entries) {
			const entry = record(rawEntry);
			assert(
				entry &&
					text(entry[field === "chains" ? "pool" : "provider"]) &&
					text(entry.model) &&
					typeof entry.enabled === "boolean",
				`Invalid ${field} target`,
			);
		}
	}
	const result = structuredClone(routes) as ChainConfig[] | PresetConfig[];
	unique(
		result.map((route) => route.name),
		field,
	);
	return result;
}

export function normalizeMultiPassConfig(raw: unknown): MultiPassConfig {
	const config = record(raw);
	assert(config, "Configuration must be an object");
	const subscriptions = array(config.subscriptions, "subscriptions");
	for (const rawEntry of subscriptions) {
		const entry = record(rawEntry);
		assert(
			entry && entry.provider === "openai-codex" && Number.isSafeInteger(entry.index) && Number(entry.index) >= 2,
			"Subscription needs an openai-codex provider and an index >= 2",
		);
		assert(entry.label === undefined || typeof entry.label === "string", "Invalid subscription label");
	}
	const entries = structuredClone(subscriptions) as SubEntry[];
	unique(entries.map(subProviderName), "subscriptions");
	for (const [key, minimum] of [
		["maxRetries", 0],
		["maxConcurrentPerAccount", 1],
		["nextSubscriptionIndex", 2],
	] as const) {
		assert(
			config[key] === undefined || (Number.isSafeInteger(config[key]) && Number(config[key]) >= minimum),
			`${key} must be an integer >= ${minimum}`,
		);
	}
	return {
		...config,
		subscriptions: entries,
		pools: normalizePools(config.pools),
		chains: normalizeRoutes(config.chains, "chains") as ChainConfig[],
		presets: normalizeRoutes(config.presets, "presets") as PresetConfig[],
		maxRetries: (config.maxRetries as number | undefined) ?? 3,
		maxConcurrentPerAccount: (config.maxConcurrentPerAccount as number | undefined) ?? 2,
	};
}

export function normalizeProjectConfig(raw: unknown): ProjectConfig {
	const parsed = record(raw);
	assert(parsed, "Project configuration must be an object");
	const config: ProjectConfig = { ...parsed };
	if (parsed.pools !== undefined) {
		config.pools = array(parsed.pools, "pools").map((entry) => {
			if (typeof entry === "string") {
				assert(text(entry) && entry === entry.trim(), "Invalid global pool name");
				return entry;
			}
			// Checked-in project definitions cannot select executable code on the host.
			const [pool] = normalizePools([entry]);
			delete pool.selectorScript;
			return pool;
		});
		unique(
			config.pools.map((pool) => (typeof pool === "string" ? pool : pool.name)),
			"pools",
		);
	}
	if (parsed.chains !== undefined) config.chains = normalizeRoutes(parsed.chains, "chains") as ChainConfig[];
	if (parsed.allowedSubs !== undefined) {
		assert(
			Array.isArray(parsed.allowedSubs) && parsed.allowedSubs.every(isCodexProviderName),
			"allowedSubs must contain exact Codex account names",
		);
		config.allowedSubs = [...new Set(parsed.allowedSubs)];
	}
	return config;
}

export function readConfig<T>(path: string, normalize: (raw: unknown) => T): T | undefined {
	let source: string;
	try {
		source = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		return normalize(JSON.parse(source));
	} catch (error) {
		throw new Error(`Invalid configuration ${path}: ${error instanceof Error ? error.message : String(error)}`, {
			cause: error,
		});
	}
}

export function writeJsonAtomic(path: string, data: unknown): void {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true });
	const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
	writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	try {
		renameSync(temporary, path);
	} catch (error) {
		unlinkSync(temporary);
		throw error;
	}
}

/** Hold the shared SQLite writer lock only for synchronous read/modify/write work. */
export function updateConfig<T, R>(
	state: SharedPoolState,
	path: string,
	normalize: (raw: unknown) => T,
	change: (config: T) => R,
): R {
	return state.withLock(() => {
		const config = readConfig(path, normalize) ?? normalize({});
		const result = change(config);
		writeJsonAtomic(path, normalize(config));
		return result;
	});
}

export function subProviderName(entry: SubEntry): string {
	return `${entry.provider}-${entry.index}`;
}

export function parseEnvConfig(raw = process.env.MULTI_SUB): SubEntry[] {
	if (!raw) return [];
	const entries: SubEntry[] = [];
	for (const part of raw.split(",")) {
		const [provider, countText = "1"] = part.trim().split(":");
		const count = Number(countText);
		assert(
			provider === "openai-codex" && Number.isSafeInteger(count) && count >= 1,
			"Invalid MULTI_SUB; expected openai-codex:<positive integer>",
		);
		for (let index = 0; index < count; index++) entries.push({ provider, index: 0 });
	}
	return entries;
}

export function mergeConfigs(
	config: Pick<MultiPassConfig, "subscriptions" | "nextSubscriptionIndex">,
	envEntries: SubEntry[],
): SubEntry[] {
	const merged = [...config.subscriptions];
	for (const entry of envEntries) {
		if (
			merged.filter((candidate) => candidate.provider === entry.provider).length >=
			envEntries.filter((candidate) => candidate.provider === entry.provider).length
		)
			continue;
		let index = config.nextSubscriptionIndex ?? 2;
		while (merged.some((candidate) => candidate.provider === entry.provider && candidate.index === index)) index++;
		merged.push({ provider: entry.provider, index });
	}
	return merged;
}

export function addSubscription(config: MultiPassConfig, label: string, env: SubEntry[] = []): SubEntry {
	const index = Math.max(
		config.nextSubscriptionIndex ?? 2,
		...mergeConfigs(config, env).map((entry) => entry.index + 1),
	);
	assert(Number.isSafeInteger(index + 1), "Subscription index is too large");
	const entry = { provider: "openai-codex", index, label: label.trim() || undefined };
	config.nextSubscriptionIndex = index + 1;
	config.subscriptions.push(entry);
	return entry;
}

export function removeSubscription(config: MultiPassConfig, expected: SubEntry): void {
	const name = subProviderName(expected);
	const current = config.subscriptions.find((entry) => subProviderName(entry) === name);
	if (!isDeepStrictEqual(current, expected))
		throw new Error(`${name} changed in another window; reopen the subscription list`);
	// Save the high-water mark before releasing any legacy provider number.
	config.nextSubscriptionIndex = Math.max(
		config.nextSubscriptionIndex ?? 2,
		...config.subscriptions.map((entry) => entry.index + 1),
	);
	for (const pool of config.pools) {
		pool.members = pool.members.filter((member) => member !== name);
		if (pool.memberSchedule) delete pool.memberSchedule[name];
	}
	const removedPools = new Set(config.pools.filter((pool) => pool.members.length === 0).map((pool) => pool.name));
	config.pools = config.pools.filter((pool) => pool.members.length > 0);
	config.chains = pruneRemovedPoolReferences(config.chains, removedPools).chains;
	for (const preset of config.presets)
		preset.entries = preset.entries.filter((entry) => entry.provider !== name && !removedPools.has(entry.provider));
	config.presets = config.presets.filter((preset) => preset.entries.length > 0);
	config.subscriptions = config.subscriptions.filter((entry) => subProviderName(entry) !== name);
}

export function buildEffectiveConfig(
	global: MultiPassConfig,
	project?: ProjectConfig,
	env: SubEntry[] = [],
): EffectiveConfig {
	const allowedProviderNames = project?.allowedSubs?.length ? project.allowedSubs : undefined;
	const allowed = allowedProviderNames && new Set(allowedProviderNames);
	const subscriptions = mergeConfigs(global, env).filter((entry) => !allowed || allowed.has(subProviderName(entry)));
	const pools = (project?.pools ?? global.pools)
		.map((pool) => (typeof pool === "string" ? global.pools.find((candidate) => candidate.name === pool) : pool))
		.filter((pool): pool is PoolConfig => pool !== undefined)
		.map((pool) => ({ ...pool, members: pool.members.filter((member) => !allowed || allowed.has(member)) }))
		.filter((pool) => pool.members.length > 0);
	const names = new Set(pools.map((pool) => pool.name));
	const chains = (project?.chains ?? global.chains)
		.map((chain) => ({ ...chain, entries: chain.entries.filter((entry) => names.has(entry.pool)) }))
		.filter((chain) => chain.entries.length > 0);
	return { ...global, subscriptions, pools, chains, allowedProviderNames };
}

export function accountProviders(config: EffectiveConfig, includeBase = true): string[] {
	const providers = [...(includeBase ? ["openai-codex"] : []), ...config.subscriptions.map(subProviderName)];
	return [...new Set(providers)].filter(
		(provider) => !config.allowedProviderNames || config.allowedProviderNames.includes(provider),
	);
}

export function requireNamed<T extends { name: string }>(entries: T[], name: string): T {
	const entry = entries.find((candidate) => candidate.name === name);
	if (!entry) throw new Error(`Configuration entry "${name}" no longer exists; reopen the menu`);
	return entry;
}

/** Replacing an edited object requires that the version the user reviewed still exists. */
export function replaceNamed<T extends { name: string }>(
	entries: T[],
	next: T,
	expected: T | undefined,
): "created" | "updated" {
	const index = entries.findIndex((entry) => entry.name === next.name);
	const current = index >= 0 ? entries[index] : undefined;
	if (!isDeepStrictEqual(current, expected))
		throw new Error(`Configuration entry "${next.name}" changed in another window; reopen the menu`);
	if (index >= 0) entries[index] = next;
	else entries.push(next);
	return index >= 0 ? "updated" : "created";
}

export function renamePoolReferences(chains: ChainConfig[], previousName: string, nextName: string): number {
	let updated = 0;
	for (const chain of chains)
		for (const entry of chain.entries) {
			if (entry.pool !== previousName) continue;
			entry.pool = nextName;
			updated++;
		}
	return updated;
}

export function pruneRemovedPoolReferences(
	chains: ChainConfig[],
	removedPoolNames: Set<string>,
): { chains: ChainConfig[]; removedEntries: number; removedChains: number } {
	let removedEntries = 0;
	for (const chain of chains) {
		const before = chain.entries.length;
		chain.entries = chain.entries.filter((entry) => !removedPoolNames.has(entry.pool));
		removedEntries += before - chain.entries.length;
	}
	const remaining = chains.filter((chain) => chain.entries.length > 0);
	return { chains: remaining, removedEntries, removedChains: chains.length - remaining.length };
}
