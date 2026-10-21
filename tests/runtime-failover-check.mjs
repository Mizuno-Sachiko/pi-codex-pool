import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { accountKey } from "../src/limits.mts";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { isRetryableAssistantError, retryAssistantCall } from "@earendil-works/pi-ai/utils/retry";
import { SharedPoolState } from "../src/shared-state.mts";
import { PoolRouter, CodexConnections, previousResponse, eventStream } from "./fixtures/router-harness.mjs";

const directory = mkdtempSync(join(tmpdir(), "multi-pass-router-"));
let fixtureIndex = 0;
const input = () => ({
	messages: [{ role: "user", content: "synthetic", timestamp: Date.now() }],
});
function fixture({ action = async () => ({}), count = 3, retries = 3, chains = [], poolOverrides = {} } = {}) {
	const state = new SharedPoolState(join(directory, `${fixtureIndex++}.sqlite`));
	const providers = Array.from({ length: count }, (_, index) => `account-${index}`);
	const tokens = new Map(
		providers.map((provider) => [
			provider,
			`header.${Buffer.from(JSON.stringify({ sub: provider, "https://api.openai.com/auth": { chatgpt_account_id: "shared-workspace" } })).toString("base64url")}.sig`,
		]),
	);
	const config = {
		pools: [{ name: "primary", members: providers, enabled: true }],
		chains,
		maxRetries: retries,
		maxConcurrentPerAccount: 2,
	};
	const calls = [];
	let checks = 0;
	const model = (provider, id = "model-a") =>
		tokens.has(provider)
			? {
					id,
					provider,
					api: "openai-codex-responses",
					reasoning: true,
					contextWindow: 1000,
					maxTokens: 100,
				}
			: undefined;
	const transport = (selected, _context, options) => {
		const stream = eventStream();
		void (async () => {
			calls.push({
				provider: selected.provider,
				model: selected.id,
				reasoning: options.reasoning,
				contextWindow: selected.contextWindow,
				thinkingLevelMap: selected.thinkingLevelMap,
			});
			const message = {
				...selected,
				role: "assistant",
				model: selected.id,
				content: [],
				stopReason: "stop",
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: message });
			const result = await action({
				selected,
				options,
				message,
				stream,
				state,
				calls,
			});
			if (result?.error) {
				await options.onResponse({ status: result.status ?? 429, headers: result.headers ?? {} }, selected);
				await options.onProviderStreamEvent(
					{
						type: "error",
						error: {
							code: result.error === "text-only" ? undefined : result.error,
							message: result.message ?? "Synthetic rejection",
						},
					},
					selected,
				);
				message.stopReason = "error";
				message.errorMessage = result.message ?? "The usage limit has been reached";
				stream.push({ type: "error", reason: "error", error: message });
			} else stream.push({ type: "done", reason: "stop", message });
			stream.end();
		})();
		return stream;
	};
	const router = new PoolRouter({
		state: () => state,
		config: () => config,
		member: (provider) => ({
			provider,
			key: accountKey(provider, tokens.get(provider)),
		}),
		hasAuth: (provider) => tokens.has(provider),
		model,
		poolModel: (pool, id) => ({ ...model(providers[0], id), provider: pool, ...poolOverrides[pool] }),
		headerNames: (model) => Object.keys(model.headers ?? {}),
		auth: async (model) => ({ auth: { apiKey: tokens.get(model.provider), headers: model.headers } }),
		order: async (_pool, members) => ({ members, ordered: false }),
		checkLimits: async () => {
			checks++;
		},
		transport: { stream: transport, streamSimple: transport },
		connections: new CodexConnections(() => {}),
	});
	const selected = { ...model(providers[0]), provider: "primary" };
	const request = (context = input(), options = {}, selection = selected) =>
		eventStream(
			router.streamSimple(selection, context, {
				sessionId: "session",
				transport: "sse",
				reasoning: "high",
				...options,
			}),
		);
	return {
		state,
		providers,
		config,
		calls,
		model,
		request,
		selected,
		router,
		tokens,
		checks: () => checks,
	};
}

let test = fixture();
const sequence = [];
for (let index = 0; index < 4; index++) sequence.push((await test.request().result()).provider);
assert.deepEqual(sequence, [test.providers[0], test.providers[1], test.providers[2], test.providers[0]]);
assert.equal(test.checks(), 0);
const conversation = input();
const response = await test.request(conversation).result();
conversation.messages.push(response, {
	role: "toolResult",
	content: [],
	timestamp: Date.now(),
});
assert.equal((await test.request(conversation).result()).provider, response.provider);
conversation.messages.push({
	role: "user",
	content: "synthetic",
	timestamp: Date.now(),
});
assert.equal(previousResponse(conversation), undefined);
assert.notEqual((await test.request(conversation).result()).provider, response.provider);
await Promise.all([
	test.request(input(), { reasoning: "low", sessionId: "child-a" }).result(),
	test.request(input(), { reasoning: "high", sessionId: "child-b" }).result(),
]);
assert.deepEqual(
	test.calls
		.slice(-2)
		.map((call) => call.reasoning)
		.sort(),
	["high", "low"],
);
assert.equal(test.selected.provider, "primary", "routing must not mutate the selected pool model");
assert.equal(Object.keys(test.state.snapshot().leases).length, 0);
test.state.close();

test = fixture({
	action: async ({ calls }) => (calls.length <= 2 ? { error: "rate_limit_exceeded" } : {}),
});
const recovered = test.request();
assert.equal((await recovered.result()).stopReason, "stop");
assert.equal(test.calls.length, 3);
assert.equal(test.checks(), 1);
assert.equal(recovered.events.filter((event) => event.type === "start").length, 1);
assert.equal(recovered.events.filter((event) => event.type === "done").length, 1);
assert.equal(recovered.events.filter((event) => event.type === "error").length, 0);
test.state.close();

test = fixture({
	count: 6,
	retries: 1,
	action: async () => ({ error: "rate_limit_exceeded" }),
});
assert.equal((await test.request().result()).stopReason, "error");
assert.equal(test.calls.length, 2, "one initial request plus one configured retry");
assert.equal(test.checks(), 1);
test.state.close();

// Pi owns transient retries; the router retains the same request route without a cooldown.
for (const rejection of [
	{ error: "server_error", status: 503, message: "Synthetic upstream failure" },
	{ error: "server_busy", status: 200, message: "Synthetic upstream failure" },
	{ error: "text-only", status: 200, message: "network error" },
]) {
	test = fixture({ retries: 0, action: async ({ calls }) => (calls.length <= 2 ? rejection : {}) });
	const context = input();
	const retried = await retryAssistantCall(
		() => test.request(structuredClone(context)).result(),
		{ enabled: true, maxRetries: 2, baseDelayMs: 0 },
		undefined,
		{
			onRetryScheduled: async () => {
				assert.deepEqual(test.state.snapshot().accounts, {}, "busy service must not penalize an account");
				assert.equal(Object.keys(test.state.snapshot().leases).length, 0);
			},
		},
	);
	assert.equal(retried.stopReason, "stop", retried.errorMessage);
	assert.equal(test.calls.length, 3, "only Pi's retry budget applies to service errors");
	assert.equal(new Set(test.calls.map((call) => call.provider)).size, 1);
	assert.equal(test.checks(), 0);
	assert.equal(test.router.retries.size, 0, "success clears the retained route");
	test.state.close();
}

test = fixture({ action: async () => ({ error: "server_error", status: 503 }) });
const unavailable = await test.request().result();
assert.equal(test.calls.length, 1, "a busy response must not trigger an internal account switch");
assert.equal(isRetryableAssistantError(unavailable), true);
assert.equal(unavailable.diagnostics?.some((entry) => entry.type === "pool_request_failure") ?? false, false);
assert.equal(test.router.retries.size, 1);
cleanupSessionResources("session");
assert.equal(test.router.retries.size, 0, "session cleanup releases retained request routes");
test.state.close();

test = fixture({ action: async () => ({ error: "server_error", status: 503 }) });
const backoffAbort = new AbortController();
const canceledBackoff = await retryAssistantCall(
	() => test.request(input(), { signal: backoffAbort.signal }).result(),
	{ enabled: true, maxRetries: 2, baseDelayMs: 0 },
	backoffAbort.signal,
	{ onRetryScheduled: async () => backoffAbort.abort() },
);
assert.equal(canceledBackoff.stopReason, "aborted");
assert.equal(test.calls.length, 1);
assert.equal(test.router.retries.size, 0, "cancellation during Pi's backoff releases the route");
test.state.close();

test = fixture({ action: async ({ calls }) => (calls.length === 1 ? { error: "server_error", status: 503 } : {}) });
const busyContext = input();
const busyResponse = await test.request(busyContext).result();
await test.request(input(), { sessionId: "other-child" }).result();
const retryContext = structuredClone(busyContext);
retryContext.messages.push(busyResponse);
const busyContinuation = await test.request(retryContext).result();
assert.equal(busyContinuation.provider, busyResponse.provider, "another child cannot change the retained account");
assert.notEqual(test.calls[1].provider, busyResponse.provider);
assert.equal(test.router.retries.size, 0);
test.state.close();

test = fixture({ action: async () => ({ error: "server_error", status: 503 }) });
const oldRequest = input();
const oldBusy = await test.request(oldRequest).result();
const newRequest = input();
newRequest.messages[0].timestamp = oldRequest.messages[0].timestamp + 1;
assert.notEqual(
	(await test.request(newRequest).result()).provider,
	oldBusy.provider,
	"a new user message rotates normally",
);
cleanupSessionResources("session");
test.state.close();

test = fixture({
	count: 2,
	retries: 0,
	poolOverrides: { backup: { contextWindow: 750 } },
	action: async ({ calls }) => (calls.length === 1 ? { error: "server_error", status: 503 } : {}),
});
test.config.pools[0].members = [test.providers[0]];
test.config.pools.push({ name: "backup", members: [test.providers[1]], enabled: true });
test.config.chains.push({
	enabled: true,
	entries: [
		{ pool: "primary", model: "model-a", enabled: true },
		{ pool: "backup", model: "model-b", enabled: true },
	],
});
let allowPrimary = false;
test.router.dependencies.order = async (pool, members) => ({
	members: pool === "primary" && !allowPrimary ? [] : members,
	ordered: false,
});
const backupBusyContext = input();
const backupBusy = await test.request(backupBusyContext).result();
assert.equal(backupBusy.provider, test.providers[1]);
allowPrimary = true;
const backupRetry = await test.request(structuredClone(backupBusyContext)).result();
assert.equal(backupRetry.provider, backupBusy.provider);
assert.equal(backupRetry.model, "model-b");
assert.equal(test.calls.at(-1).contextWindow, 750, "service retries retain backup pool metadata");
test.state.close();

test = fixture({ action: async ({ calls }) => (calls.length === 1 ? { error: "invalid_api_key", status: 401 } : {}) });
assert.equal((await test.request().result()).stopReason, "stop");
assert.equal(test.calls.length, 2, "an explicit account rejection can switch accounts");
assert.notEqual(test.calls[0].provider, test.calls[1].provider);
assert.equal(test.checks(), 0);
test.state.close();

test = fixture({ action: async () => ({ error: "usage_limit_reached" }) });
assert.equal((await test.request(input(), {}, test.model(test.providers[0])).result()).stopReason, "error");
assert.deepEqual(
	test.calls.map((call) => call.provider),
	[test.providers[0]],
	"physical accounts remain pinned",
);
test.state.close();

test = fixture({
	action: async ({ message, stream }) => {
		message.content.push({ type: "text", text: "partial response" });
		stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta: "partial response",
			partial: message,
		});
		return { error: "rate_limit_exceeded" };
	},
});
const partial = test.request();
assert.equal((await partial.result()).content[0].text, "partial response");
assert.equal(test.calls.length, 1, "content already emitted must not be replayed on another account");
assert.equal(partial.events.filter((event) => event.type === "start").length, 1);
test.state.close();

const gate = Promise.withResolvers();
test = fixture({ count: 1, action: async () => gate.promise });
const busy = [test.request().result(), test.request().result()];
while (test.calls.length < 2) await wait(5);
const canceled = new AbortController();
const waiting = test.request(input(), { signal: canceled.signal }).result();
await wait(30);
assert.equal(test.calls.length, 2);
canceled.abort();
assert.equal((await waiting).stopReason, "aborted");
assert.equal(Object.keys(test.state.snapshot().waiters).length, 0);
gate.resolve({});
await Promise.all(busy);
assert.equal(Object.keys(test.state.snapshot().leases).length, 0);
test.state.close();

test = fixture({
	count: 4,
	retries: 5,
	action: async ({ selected }) => (selected.provider !== "account-3" ? { error: "rate_limit_exceeded" } : {}),
});
test.config.pools[0].members = test.providers.slice(0, 3);
test.config.pools.push({
	name: "backup",
	members: [test.providers[3]],
	enabled: true,
});
test.config.chains.push({
	enabled: true,
	entries: [
		{ pool: "primary", model: "model-a", enabled: true },
		{ pool: "backup", model: "model-b", enabled: true },
	],
});
const chainContext = input();
const backup = await test.request(chainContext).result();
assert.equal(backup.provider, "account-3");
assert.equal(backup.model, "model-b");
chainContext.messages.push(backup, { role: "toolResult", content: [] });
assert.equal(
	(await test.request(chainContext).result()).model,
	"model-b",
	"chain continuations retain their dispatched model",
);
test.state.close();

for (const backupId of ["model-a", "model-b"]) {
	test = fixture({ count: 2, poolOverrides: { backup: { contextWindow: 750, thinkingLevelMap: { low: "high" } } } });
	test.config.pools[0].members = [test.providers[0]];
	test.config.pools.push({ name: "backup", members: [test.providers[1]], enabled: true });
	test.config.chains.push({
		enabled: true,
		entries: [
			{ pool: "primary", model: "model-a", enabled: true },
			{ pool: "backup", model: backupId, enabled: true },
		],
	});
	test.state.fail(
		accountKey(
			test.providers[0],
			`header.${Buffer.from(JSON.stringify({ sub: test.providers[0], "https://api.openai.com/auth": { chatgpt_account_id: "shared-workspace" } })).toString("base64url")}.sig`,
		),
		"synthetic",
		Date.now() + 60_000,
	);
	const fallbackContext = input();
	const fallback = await test.request(fallbackContext, { reasoning: "low" }).result();
	assert.equal(fallback.provider, test.providers[1]);
	assert.equal(test.calls.at(-1).contextWindow, 750);
	assert.deepEqual(test.calls.at(-1).thinkingLevelMap, { low: "high" });
	fallbackContext.messages.push(fallback, { role: "toolResult", content: [] });
	await test.request(fallbackContext).result();
	assert.equal(test.calls.at(-1).contextWindow, 750, "fallback continuations retain their pool metadata");
	test.state.close();
}

test = fixture({
	count: 1,
	action: async () => ({ error: "text-only", message: "You have hit your ChatGPT usage limit. Try again in ~99 min." }),
});
const rejected = await test.request().result();
assert.equal(rejected.stopReason, "error");
let [key, account] = Object.entries(test.state.snapshot().accounts)[0];
assert.ok(account.blockedUntil > Date.now() + 90 * 60_000);
assert.ok(account.cooldownUntil <= Date.now() + 30_000);
test.state.finishRefresh(key, test.state.beginRefresh(key, 0).id, {
	kind: "ready",
	checkedAt: Date.now() + 1,
	summary: "ready",
	score: 80,
	details: [],
});
account = test.state.snapshot().accounts[key];
assert.equal(account.blockedUntil, undefined);
assert.ok(account.cooldownUntil <= Date.now() + 30_000);
test.state.close();

test = fixture({ count: 1, action: async () => ({ error: "rate_limit_exceeded", headers: { "retry-after": "600" } }) });
await test.request().result();
[key, account] = Object.entries(test.state.snapshot().accounts)[0];
test.state.finishRefresh(key, test.state.beginRefresh(key, 0).id, {
	kind: "ready",
	checkedAt: Date.now() + 1,
	summary: "ready",
	score: 80,
	details: [],
});
assert.equal(
	test.state.snapshot().accounts[key].cooldownUntil,
	account.cooldownUntil,
	"fresh quota must respect explicit retry headers",
);
test.state.close();

test = fixture();
test.tokens.set(test.providers[0], "damaged-token");
const valid = await test.request().result();
assert.equal(valid.provider, test.providers[1], valid.errorMessage);
test.state.close();

test = fixture();
let releaseCalls = 0;
test.state.release = () => {
	releaseCalls++;
	throw new Error("Synthetic SQLite release failure");
};
const cleanup = test.request();
const cleanupResult = await Promise.race([
	cleanup.result(),
	wait(2000).then(() => {
		throw new Error("Missing terminal event");
	}),
]);
assert.equal(cleanupResult.stopReason, "stop");
assert.equal(cleanupResult.diagnostics.at(-1).type, "pool_cleanup_failure");
assert.equal(releaseCalls, 1);
assert.equal(cleanup.events.filter((event) => event.type === "done" || event.type === "error").length, 1);
test.state.close();

// Both targets share an account and model; the recorded target identifies the pool.
test = fixture({ count: 2, poolOverrides: { backup: { contextWindow: 750 } } });
test.config.pools.push({ name: "backup", members: [test.providers[1]], enabled: true });
test.config.chains.push({
	enabled: true,
	entries: [
		{ pool: "primary", model: "model-a", enabled: true },
		{ pool: "backup", model: "model-a", enabled: true },
	],
});
let primaryAvailable = false;
test.router.dependencies.order = async (name, members) => ({
	members: name === "primary" && !primaryAvailable ? [] : members,
	ordered: false,
});
const overlap = input();
const routed = await test.request(overlap).result();
assert.equal(routed.diagnostics.at(-1).details.pool, "backup");
primaryAvailable = true;
overlap.messages.push(JSON.parse(JSON.stringify(routed)), { role: "toolResult", content: [] });
assert.equal((await test.request(overlap).result()).provider, test.providers[1]);
assert.equal(test.calls.at(-1).contextWindow, 750);
test.state.close();

const closed = [];
const connections = new CodexConnections((session) => closed.push(session));
const release = await connections.acquire("session", "member-a", new AbortController().signal);
const abort = new AbortController();
const queued = connections.acquire("session", "member-b", abort.signal);
abort.abort();
await assert.rejects(queued, { name: "AbortError" });
let entered = false;
const next = connections.acquire("session", "member-c", new AbortController().signal).then((unlock) => {
	entered = true;
	return unlock;
});
await wait(10);
assert.equal(entered, false);
release();
(await next)();
(await connections.acquire("session", "member-c", new AbortController().signal))();
assert.equal(closed.length, 2, "workspace members need separate sockets, continuations reuse their own socket");
for (let index = 0; index < 1000; index++) {
	const id = `child-${index}`;
	(await connections.acquire(id, "synthetic", new AbortController().signal))();
	cleanupSessionResources(id);
}
cleanupSessionResources("session");
assert.equal(connections.users.size, 0, "finished child sessions must release their identity mappings");
console.log(
	"request-local routing, subagent independence, bounded retries, partial output, cancellation, chains, and socket ownership checks passed",
);
