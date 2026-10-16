import assert from "node:assert/strict";
import {
	parseCodexUsageSnapshot,
	getCodexWindowRemaining,
	classifyCodexQuotaKind,
	exhaustedResetAt,
} from "../src/quota.mts";

const resetAt = Math.floor(Date.now() / 1000) + 3600;
const snapshot = parseCodexUsageSnapshot({
	plan_type: "team",
	rate_limit: {
		allowed: true,
		limit_reached: false,
		primary_window: {
			used_percent: 35,
			limit_window_seconds: 604800,
			reset_at: resetAt + 604800,
		},
		secondary_window: {
			used_percent: 10,
			limit_window_seconds: 18000,
			reset_at: resetAt,
		},
	},
});
assert.equal(snapshot.planType, "team");
assert.equal(snapshot.fiveHour.windowSeconds, 18000);
assert.equal(snapshot.weekly.windowSeconds, 604800);
assert.equal(getCodexWindowRemaining(snapshot.fiveHour), 90);
assert.equal(getCodexWindowRemaining(snapshot.weekly), 65);
assert.equal(classifyCodexQuotaKind(snapshot).kind, "ready");
assert.equal(classifyCodexQuotaKind({ fiveHour: { usedPercent: 75 } }).kind, "watch");
assert.equal(classifyCodexQuotaKind({ fiveHour: { usedPercent: 97 } }).kind, "low");
assert.equal(classifyCodexQuotaKind({ fiveHour: { usedPercent: 100 } }).kind, "blocked");
assert.equal(classifyCodexQuotaKind({ allowed: false, fiveHour: { usedPercent: 20 } }).kind, "blocked");
assert.equal(classifyCodexQuotaKind({ allowed: true, fiveHour: { usedPercent: 100 } }).kind, "blocked");
assert.equal(classifyCodexQuotaKind({}).kind, "error");
assert.equal(
	classifyCodexQuotaKind(
		parseCodexUsageSnapshot({
			rate_limit: { primary_window: { limit_window_seconds: 18000 } },
		}),
	).kind,
	"error",
	"missing percentages must not be treated as unused quota",
);
const funded = parseCodexUsageSnapshot({
	rate_limit: {
		limit_reached: true,
		primary_window: { used_percent: 100, limit_window_seconds: 18000 },
	},
	credits: { has_credits: true },
	spend_control: { reached: false },
});
assert.equal(
	classifyCodexQuotaKind(funded).kind,
	"blocked",
	"purchased credits must not bypass exhausted subscription windows",
);
assert.equal(classifyCodexQuotaKind({ ...funded, allowed: false }).kind, "blocked");
assert.equal(
	classifyCodexQuotaKind(
		parseCodexUsageSnapshot({
			rate_limit: { allowed: false, limit_reached: true },
			credits: { has_credits: true, overage_limit_reached: true },
		}),
	).kind,
	"blocked",
);
assert.equal(
	classifyCodexQuotaKind(
		parseCodexUsageSnapshot({
			rate_limit: { allowed: false, limit_reached: false },
			credits: { has_credits: true },
		}),
	).kind,
	"blocked",
	"credits do not override unrelated denials",
);
assert.equal(
	exhaustedResetAt({
		fiveHour: { usedPercent: 100, resetAt },
		weekly: { usedPercent: 100, resetAt: resetAt + 604800 },
	}),
	resetAt + 604800,
);
assert.equal(
	exhaustedResetAt({ fiveHour: { usedPercent: 100, resetAt }, weekly: { usedPercent: 20, resetAt: resetAt + 604800 } }),
	resetAt,
);
assert.equal(exhaustedResetAt({}), undefined);
console.log("production quota parsing and classification checks passed");
