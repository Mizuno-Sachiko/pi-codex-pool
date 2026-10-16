import assert from "node:assert/strict";
import { accountKey, classifyFailure, retryAtFromText } from "../src/limits.mts";

assert.equal(classifyFailure("HTTP 503 while contacting upstream").kind, "overload");
assert.equal(classifyFailure("provider at capacity").kind, "overload");
assert.equal(classifyFailure("request id 14290 logged").kind, "other");
assert.equal(classifyFailure("The usage limit has been reached").kind, "quota");
assert.equal(classifyFailure("too many requests", { error: { code: "rate_limit_exceeded" } }, 429).kind, "rate");
assert.equal(classifyFailure("usage limit", { error: { type: "usage_limit_reached" } }, 429).kind, "quota");
assert.equal(classifyFailure("usage limit", { error: { code: "rate_limit_exceeded" } }, 429).kind, "rate");
assert.equal(classifyFailure("Unauthorized", undefined, 401).kind, "auth");
assert.equal(
	classifyFailure("context exceeded with 503 output tokens", { error: { code: "context_length_exceeded" } }, 400).kind,
	"other",
);
assert.equal(classifyFailure("requested 503 tokens", undefined, 400).kind, "other");
assert.equal(classifyFailure("requested 429 tokens", undefined, 400).kind, "other");
assert.equal(classifyFailure("requested 429 tokens").kind, "other");
assert.equal(classifyFailure("HTTP 429 too many requests").kind, "rate");
assert.equal(
	classifyFailure("rate limit mentioned in invalid input", { error: { code: "invalid_argument" } }, 400).kind,
	"other",
);
assert.equal(classifyFailure("Request rejected", undefined, 429).kind, "rate");
const now = 1_800_000_000_000;
assert.equal(retryAtFromText("Try again in ~99 min.", now), now + 99 * 60_000);
assert.equal(retryAtFromText("Retry-After: 120", now), now + 120_000);
const estimate = classifyFailure(
	"You have hit your ChatGPT usage limit. Try again in ~99 min.",
	undefined,
	429,
	{},
	now,
);
assert.equal(estimate.kind, "quota");
assert.equal(estimate.retryAt, now + 99 * 60_000);
assert.equal(estimate.requestRetryAt, undefined, "a prose estimate must not become a hard request cooldown");
for (const [headers, retryAt] of [
	[{ "retry-after": "12" }, now + 12_000],
	[{ "retry-after-ms": "750" }, now + 750],
	[{ "retry-after": new Date(now + 12_000).toUTCString() }, now + 12_000],
]) {
	const failure = classifyFailure("request rejected", undefined, 429, headers, now);
	assert.equal(failure.retryAt, retryAt);
	assert.equal(failure.requestRetryAt, retryAt);
}
const reset = classifyFailure(
	"usage limit",
	{ error: { type: "usage_limit_reached", resets_at: (now + 100_000) / 1000 } },
	429,
	{},
	now,
);
assert.equal(reset.retryAt, now + 100_000);
assert.equal(reset.requestRetryAt, undefined);
const token = (user, workspace, signature) =>
	`header.${Buffer.from(JSON.stringify({ sub: user, "https://api.openai.com/auth": { chatgpt_account_id: workspace } })).toString("base64url")}.${signature}`;
assert.equal(accountKey("account-a", token("user", "team", "old")), accountKey("alias", token("user", "team", "new")));
assert.notEqual(
	accountKey("account-a", token("user-a", "team", "sig")),
	accountKey("account-b", token("user-b", "team", "sig")),
);
console.log("failure classification, wait provenance and account identity checks passed");
