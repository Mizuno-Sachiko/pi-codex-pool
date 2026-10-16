import { record } from "./limits.mts";
import type { StoredQuota } from "./shared-state.mts";

export interface CodexUsageWindow {
	usedPercent: number;
	windowSeconds: number;
	resetAt?: number;
}
export interface CodexUsageSnapshot {
	planType: string;
	email: string;
	fiveHour?: CodexUsageWindow;
	weekly?: CodexUsageWindow;
	allowed?: boolean;
	limitReached?: boolean;
}

function normalizeWindow(value: unknown): CodexUsageWindow | undefined {
	const raw = record(value);
	if (typeof raw?.used_percent !== "number" || !Number.isFinite(raw.used_percent)) return undefined;
	return {
		usedPercent: raw.used_percent,
		windowSeconds: typeof raw.limit_window_seconds === "number" ? raw.limit_window_seconds : 0,
		resetAt: typeof raw.reset_at === "number" && Number.isFinite(raw.reset_at) ? raw.reset_at : undefined,
	};
}

export function parseCodexUsageSnapshot(data: unknown): CodexUsageSnapshot {
	const raw = record(data);
	const rateLimit = record(raw?.rate_limit);
	const windows = [normalizeWindow(rateLimit?.primary_window), normalizeWindow(rateLimit?.secondary_window)];
	const findWindow = (seconds: number) =>
		windows.find((window) => window && Math.abs(window.windowSeconds - seconds) <= 120);
	return {
		planType: typeof raw?.plan_type === "string" ? raw.plan_type : "unknown",
		email: typeof raw?.email === "string" ? raw.email : "",
		fiveHour: findWindow(5 * 60 * 60),
		weekly: findWindow(7 * 24 * 60 * 60),
		allowed: typeof rateLimit?.allowed === "boolean" ? rateLimit.allowed : undefined,
		limitReached: typeof rateLimit?.limit_reached === "boolean" ? rateLimit.limit_reached : undefined,
	};
}

export function getCodexWindowRemaining(window: CodexUsageWindow | undefined): number | undefined {
	return window ? Math.max(0, Math.min(100, 100 - window.usedPercent)) : undefined;
}

export function classifyCodexQuotaKind(snapshot: CodexUsageSnapshot): Pick<StoredQuota, "kind" | "score"> {
	const values = [getCodexWindowRemaining(snapshot.fiveHour), getCodexWindowRemaining(snapshot.weekly)].filter(
		(value): value is number => value !== undefined,
	);
	const score = values.length > 0 ? Math.min(...values) : 0;
	if (snapshot.allowed === false || snapshot.limitReached === true || (values.length > 0 && score <= 0)) {
		return { kind: "blocked", score };
	}
	if (values.length === 0 && snapshot.allowed !== true) return { kind: "error", score: 0 };
	return { kind: score <= 15 ? "low" : score <= 30 ? "watch" : "ready", score };
}

export function exhaustedResetAt(snapshot: CodexUsageSnapshot, now = Date.now()): number | undefined {
	// Every exhausted window must reset before the account can serve again.
	const resets = [snapshot.fiveHour, snapshot.weekly]
		.filter((window) => window && window.usedPercent >= 100)
		.map((window) => window?.resetAt)
		.filter((reset): reset is number => reset !== undefined && reset * 1000 > now);
	return resets.length ? Math.max(...resets) : undefined;
}
