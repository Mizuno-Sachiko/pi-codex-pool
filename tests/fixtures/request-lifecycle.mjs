import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire, findPackageJSON } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { accountKey } from "../../src/limits.mts";
import { SharedPoolState } from "../../src/shared-state.mts";

const piManifest = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
assert.ok(piManifest, "Install the development dependencies before running this check");
const piPackage = process.argv[2] ?? dirname(piManifest);
const agentDir = mkdtempSync(join(tmpdir(), "multi-pass-runtime-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(agentDir, { recursive: true });
const subscriptions = [2, 3, 4].map((index) => ({
	provider: "openai-codex",
	index,
}));
const names = subscriptions.map((entry) => `${entry.provider}-${entry.index}`);
const tokens = new Map(
	names.map((name, index) => [
		name,
		`header.${Buffer.from(JSON.stringify({ sub: `user-${index}`, "https://api.openai.com/auth": { chatgpt_account_id: "shared-workspace" } })).toString("base64url")}.sig`,
	]),
);
const configPath = join(agentDir, "multi-pass.json");
const config = {
	subscriptions,
	pools: [
		{
			name: "test",
			baseProvider: "openai-codex",
			members: names,
			enabled: true,
			strategy: "round-robin",
		},
	],
	maxRetries: 3,
	maxConcurrentPerAccount: 2,
};
writeFileSync(configPath, JSON.stringify(config));
writeFileSync(
	join(agentDir, "auth.json"),
	JSON.stringify(
		Object.fromEntries(
			names.map((name) => [
				name,
				{
					type: "oauth",
					access: tokens.get(name),
					refresh: "synthetic",
					expires: Date.now() + 3_600_000,
				},
			]),
		),
	),
);
const credentialsBefore = readFileSync(join(agentDir, "auth.json"), "utf8");
const { loadExtensions } = await import(pathToFileURL(join(piPackage, "dist/core/extensions/loader.js")).href);
const { ModelRuntime } = await import(pathToFileURL(join(piPackage, "dist/core/model-runtime.js")).href);
const { createEventBus } = await import(pathToFileURL(join(piPackage, "dist/core/event-bus.js")).href);
const eventBus = createEventBus();
const source = fileURLToPath(new URL("../../extensions/multi-sub.ts", import.meta.url));
const cwd = fileURLToPath(new URL("../../", import.meta.url));
let usageCalls = 0;
const previousFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
	assert.match(String(url), /\/wham\/usage$/, "all network access must stay inside the quota stub");
	usageCalls++;
	return Response.json({
		plan_type: "team",
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: {
				used_percent: 20,
				limit_window_seconds: 18000,
				reset_at: Math.floor(Date.now() / 1000) + 3600,
			},
		},
	});
};
const waitingResolvers = [];
try {
	const loaded = await loadExtensions([source], cwd, eventBus);
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions[0];
	const runtime = await ModelRuntime.create({ allowModelNetwork: false });
	const aiPackage = findPackageJSON("@earendil-works/pi-ai", join(piPackage, "package.json"));
	const { isRetryableAssistantError, retryAssistantCall } = createRequire(aiPackage)("./dist/utils/retry.js");
	function applyRegistrations(target) {
		for (const entry of loaded.runtime.pendingProviderRegistrations) target.registerProvider(entry.name, entry.config);
		for (const entry of loaded.runtime.pendingNativeProviderRegistrations)
			target.registerNativeProvider(entry.provider);
	}
	applyRegistrations(runtime);
	await runtime.refresh({ allowNetwork: false });
	const pool = runtime.getProvider("test");
	assert.ok(pool);
	assert.equal(runtime.getProvider(names[0]).auth.oauth.name, "ChatGPT Codex #2");
	const definitions = pool.getModels();
	assert.ok(definitions.length > 0);
	const modelId = definitions[0].id;
	const selected = runtime.getModel("test", modelId);
	assert.ok(selected);
	assert.ok((await runtime.getAvailable("test")).length > 0, "pool models must be available without separate login");
	assert.equal(pool.auth.oauth, undefined, "the pool must not own a duplicate OAuth credential");
	const ctx = {
		cwd,
		hasUI: false,
		mode: "json",
		model: selected,
		ui: { setStatus() {}, notify() {}, select: async () => undefined },
		sessionManager: { getSessionId: () => "test-session" },
		modelRegistry: {
			getAll: () => [...runtime.getModels()],
			find: (provider, id) => runtime.getModel(provider, id),
			getProviderAuthStatus: (provider) => runtime.getProviderAuthStatus(provider),
			refresh: (options) => runtime.refresh({ allowNetwork: false, ...options }),
		},
	};
	loaded.runtime.setModel = async () => {
		throw new Error("request routing must not change the selected model");
	};
	loaded.runtime.sendUserMessage = () => {
		throw new Error("request routing must not replay a user message");
	};
	async function emit(name, event) {
		for (const handler of extension.handlers.get(name) ?? []) await handler(event, ctx);
	}
	await emit("session_start", {});
	const input = () => ({
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: "synthetic input" }],
				timestamp: Date.now(),
			},
		],
	});
	const completed = () =>
		new Response(
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					id: "response-test",
					status: "completed",
					output: [],
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			})}\n\n`,
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
	const sent = [];
	const options = (extra = {}) => {
		let payload;
		let dispatchedModel;
		return {
			transport: "sse",
			sessionId: "test-session",
			reasoning: "high",
			onPayload: (value, model) => {
				payload = value;
				dispatchedModel = model;
			},
			fetch: async (_url, init) => {
				sent.push({
					bearer: new Headers(init.headers).get("authorization"),
					headers: Object.fromEntries(new Headers(init.headers)),
					reasoning: payload?.reasoning?.effort,
					contextWindow: dispatchedModel?.contextWindow,
				});
				return completed();
			},
			...extra,
		};
	};
	const request = (context = input(), extra = {}, model = selected, target = runtime) =>
		target.streamSimple(model, context, options(extra));
	const providers = [];
	for (let index = 0; index < 4; index++) {
		const message = await request().result();
		assert.equal(message.stopReason, "stop", message.errorMessage);
		providers.push(message.provider);
	}
	assert.deepEqual(providers, [names[0], names[1], names[2], names[0]]);
	assert.equal(usageCalls, 0, "normal requests must not query quota");
	const context = input();
	const first = await request(context).result();
	context.messages.push(first, {
		role: "toolResult",
		toolCallId: "synthetic",
		toolName: "synthetic",
		content: [],
		isError: false,
		timestamp: Date.now(),
	});
	assert.equal((await request(context).result()).provider, first.provider);

	// Frontend children inherit providers, without receiving the parent's lifecycle handlers.
	const child = await ModelRuntime.create({ allowModelNetwork: false });
	applyRegistrations(child);
	await child.refresh({ allowNetwork: false });
	const childModel = child.getModel("test", modelId);
	const responses = await Promise.all([
		request(input(), { sessionId: "child-low", reasoning: "low" }, childModel, child).result(),
		request(input(), { sessionId: "child-high", reasoning: "high" }, childModel, child).result(),
	]);
	for (const response of responses) assert.equal(response.stopReason, "stop", response.errorMessage);
	assert.deepEqual(
		sent
			.slice(-2)
			.map((request) => request.reasoning)
			.sort(),
		["high", "low"],
	);
	assert.notEqual(sent.at(-1).bearer, sent.at(-2).bearer);
	assert.equal(ctx.model.provider, "test");

	const waiting = [];
	let entered = 0;
	const six = Promise.withResolvers();
	for (let index = 0; index < 6; index++)
		waiting.push(
			request(input(), {
				sessionId: `child-${index}`,
				fetch: async () => {
					entered++;
					if (entered === 6) six.resolve();
					return new Promise((resolve) => waitingResolvers.push(() => resolve(completed())));
				},
			}).result(),
		);
	await Promise.race([
		six.promise,
		delay(5000).then(() => {
			throw new Error(`Only ${entered} requests acquired slots`);
		}),
	]);
	const abort = new AbortController();
	const queued = request(input(), {
		sessionId: "queued-child",
		signal: abort.signal,
		fetch: async () => {
			throw new Error("A seventh request exceeded the cap");
		},
	}).result();
	await delay(400);
	abort.abort();
	assert.equal((await queued).stopReason, "aborted");
	for (const resolve of waitingResolvers) resolve();
	for (const result of await Promise.all(waiting)) assert.equal(result.stopReason, "stop", result.errorMessage);

	const physicalWindow = runtime.getModel(names[0], modelId).contextWindow;
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				test: {
					modelOverrides: {
						[modelId]: {
							contextWindow: physicalWindow + 1000,
							thinkingLevelMap: { ...selected.thinkingLevelMap, low: "high" },
						},
					},
				},
			},
		}),
	);
	await runtime.refresh({ allowNetwork: false });
	const overridden = runtime.getModel("test", modelId);
	assert.equal(overridden.contextWindow, physicalWindow + 1000);
	assert.equal(runtime.getModel(names[0], modelId).contextWindow, physicalWindow);
	const overriddenResponse = await request(input(), { reasoning: "low" }, overridden).result();
	assert.equal(overriddenResponse.stopReason, "stop", overriddenResponse.errorMessage);
	assert.equal(sent.at(-1).reasoning, "high", "pool-specific thinking metadata must reach native request conversion");

	const scopedCwd = join(agentDir, "restricted-project");
	mkdirSync(join(scopedCwd, ".pi"), { recursive: true });
	writeFileSync(join(scopedCwd, ".pi", "multi-pass.json"), JSON.stringify({ allowedSubs: [names[1]] }));
	const scopedContext = {
		...ctx,
		cwd: scopedCwd,
		sessionManager: { getSessionId: () => "restricted-session" },
	};
	for (const handler of extension.handlers.get("session_start") ?? []) await handler({}, scopedContext);
	const scopedChild = await ModelRuntime.create({ allowModelNetwork: false });
	applyRegistrations(scopedChild);
	await scopedChild.refresh({ allowNetwork: false });
	const scopedResponse = await request(
		input(),
		{ sessionId: "restricted-child" },
		scopedChild.getModel("test", modelId),
		scopedChild,
	).result();
	assert.equal(scopedResponse.provider, names[1], scopedResponse.errorMessage);
	const forbidden = await request(
		input(),
		{
			fetch: async () => {
				throw new Error("A restricted account must not receive the request");
			},
		},
		scopedChild.getModel(names[0], modelId),
		scopedChild,
	).result();
	assert.equal(forbidden.stopReason, "error");
	assert.match(forbidden.errorMessage, /No authenticated account/);
	const originalScope = await request(
		input(),
		{ sessionId: "original-child" },
		child.getModel(names[0], modelId),
		child,
	).result();
	assert.equal(originalScope.stopReason, "stop", originalScope.errorMessage);
	assert.equal(originalScope.provider, names[0], "an inherited provider must retain its original project scope");
	await emit("session_start", {});

	const busyContext = input();
	const busyAccounts = [];
	const recoveredBusy = await retryAssistantCall(
		() =>
			request(structuredClone(busyContext), {
				fetch: async (_url, init) => {
					busyAccounts.push(new Headers(init.headers).get("authorization"));
					return busyAccounts.length < 3
						? Response.json({ error: { code: "server_error", message: "Synthetic service failure" } }, { status: 503 })
						: completed();
				},
			}).result(),
		{ enabled: true, maxRetries: 2, baseDelayMs: 0 },
	);
	assert.equal(recoveredBusy.stopReason, "stop", recoveredBusy.errorMessage);
	assert.equal(busyAccounts.length, 3);
	assert.equal(new Set(busyAccounts).size, 1, "native Pi retries must retain the selected account");
	assert.equal(usageCalls, 0, "busy services must not trigger quota queries");

	const shared = new SharedPoolState(join(agentDir, "multi-pass.sqlite"));
	const primaryKey = accountKey(names[0], tokens.get(names[0]));
	try {
		config.pools[0].members = [names[0]];
		config.pools.push({ name: "backup", baseProvider: "openai-codex", members: [names[1]], enabled: true });
		for (const backupId of [modelId, definitions.find((model) => model.id !== modelId && model.reasoning)?.id].filter(
			Boolean,
		)) {
			config.chains = [
				{
					name: "test-chain",
					enabled: true,
					entries: [
						{ pool: "test", model: modelId, enabled: true },
						{ pool: "backup", model: backupId, enabled: true },
					],
				},
			];
			writeFileSync(configPath, JSON.stringify(config));
			writeFileSync(
				join(agentDir, "models.json"),
				JSON.stringify({
					providers: {
						backup: {
							modelOverrides: {
								[backupId]: { contextWindow: 64000, thinkingLevelMap: { low: "high" } },
							},
						},
					},
				}),
			);
			shared.fail(primaryKey, "synthetic cooldown", Date.now() + 60_000);
			const fallbackContext = input();
			const fallback = await request(fallbackContext, { reasoning: "low" }).result();
			assert.equal(fallback.stopReason, "stop", fallback.errorMessage);
			assert.equal(fallback.provider, names[1]);
			assert.equal(fallback.model, backupId);
			assert.equal(sent.at(-1).contextWindow, 64000);
			assert.equal(sent.at(-1).reasoning, "high");
			fallbackContext.messages.push(fallback, {
				role: "toolResult",
				toolCallId: "synthetic",
				toolName: "synthetic",
				content: [],
				isError: false,
				timestamp: Date.now(),
			});
			const continued = await request(fallbackContext, { reasoning: "low" }).result();
			assert.equal(continued.model, backupId);
			assert.equal(sent.at(-1).contextWindow, 64000);
		}
	} finally {
		shared.succeed(primaryKey, Date.now() + 1);
		shared.close();
		config.pools[0].members = names;
		config.pools.pop();
		config.chains = [];
		writeFileSync(configPath, JSON.stringify(config));
	}

	let attempts = 0;
	const recovered = await request(input(), {
		fetch: async () =>
			++attempts === 1
				? Response.json(
						{
							error: {
								code: "rate_limit_exceeded",
								message: "Synthetic rejection",
							},
						},
						{ status: 429 },
					)
				: completed(),
	}).result();
	assert.equal(recovered.stopReason, "stop", recovered.errorMessage);
	assert.equal(attempts, 2);
	assert.equal(usageCalls, 3, "one rejection checks all accounts once");
	await extension.commands.get("subs").handler("limits", ctx);
	assert.equal(usageCalls, 3, "manual checks reuse a recent shared snapshot");
	assert.equal(readFileSync(join(agentDir, "auth.json"), "utf8"), credentialsBefore);

	const stopped = await request(input(), {
		fetch: async () =>
			Response.json(
				{
					error: {
						code: "rate_limit_exceeded",
						message: "Synthetic rejection",
					},
				},
				{ status: 429 },
			),
	}).result();
	assert.equal(stopped.stopReason, "error");
	assert.match(stopped.errorMessage, /Pool stopped after/);
	assert.equal(stopped.diagnostics.at(-1).type, "pool_request_failure");
	assert.equal(isRetryableAssistantError(stopped), false, "Pi must not restart the pool's completed retry budget");

	// Exercise configured headers through Pi's actual request preparation.
	const state = new SharedPoolState(join(agentDir, "multi-pass.sqlite"));
	try {
		for (const name of names) state.succeed(accountKey(name, tokens.get(name)), Date.now() + 1);
		config.pools[0].members = [names[0]];
		config.pools.push({ name: "backup", baseProvider: "openai-codex", members: [names[1]], enabled: true });
		config.chains = [
			{
				name: "headers",
				enabled: true,
				entries: [
					{ pool: "test", model: modelId, enabled: true },
					{ pool: "backup", model: modelId, enabled: true },
				],
			},
		];
		writeFileSync(configPath, JSON.stringify(config));
		const headerScript = join(agentDir, "header-value.mjs");
		writeFileSync(
			headerScript,
			`import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2], 'called\\n');\nconsole.log(process.argv[3] + '-' + Date.now());\n`,
			{ flag: "wx" },
		);
		const headerLog = join(agentDir, "header-calls.log");
		const dynamicHeader = `!"${process.execPath}" "${headerScript}" "${headerLog}" primary`;
		const headerConfig = {
			providers: {
				[names[0]]: { modelOverrides: { [modelId]: { headers: { "x-member-model": "first" } } } },
				[names[1]]: { modelOverrides: { [modelId]: { headers: { "x-member-model": "second" } } } },
				test: { headers: { "x-pool-scope": "primary", "x-primary-only": "yes", "x-dynamic": dynamicHeader } },
				backup: { headers: { "x-pool-scope": "backup", "x-backup-only": "yes" } },
			},
		};
		writeFileSync(join(agentDir, "models.json"), JSON.stringify(headerConfig));
		await runtime.refresh({ allowNetwork: false });
		const headerModel = runtime.getModel("test", modelId);
		const headerResponse = await request(input(), {}, headerModel).result();
		assert.equal(
			headerResponse.stopReason,
			"stop",
			JSON.stringify(headerResponse.diagnostics ?? headerResponse.errorMessage),
		);
		assert.equal(sent.at(-1).headers["x-member-model"], "first");
		assert.equal(
			readFileSync(headerLog, "utf8").trim().split("\n").length,
			1,
			"source header commands must execute once per request",
		);
		state.fail(primaryKey, "synthetic cooldown", Date.now() + 60_000, Date.now() + 3_600_000);
		assert.equal((await request(input(), {}, headerModel).result()).provider, names[1]);
		assert.equal(sent.at(-1).headers["x-pool-scope"], "backup");
		assert.equal(sent.at(-1).headers["x-primary-only"], undefined);
		assert.equal(sent.at(-1).headers["x-member-model"], "second");
		assert.equal(sent.at(-1).headers["x-backup-only"], "yes");
		assert.equal(sent.at(-1).headers["x-dynamic"], undefined, "source dynamic headers must not escape to another pool");
		assert.equal(readFileSync(headerLog, "utf8").trim().split("\n").length, 2);
		await request(input(), { headers: { "X-Pool-Scope": "caller", "x-explicit": "kept" } }, headerModel).result();
		assert.equal(
			sent.at(-1).headers["x-pool-scope"],
			"backup",
			"same-name caller fields remain scoped to the source pool",
		);
		assert.equal(sent.at(-1).headers["x-explicit"], "kept");

		// A model added after extension loading must be selectable and routable.
		const customId = "synthetic-added-model";
		headerConfig.providers[names[1]].models = [{ ...definitions[0], id: customId, name: "Synthetic model" }];
		writeFileSync(join(agentDir, "models.json"), JSON.stringify(headerConfig));
		config.pools[0].members = [names[1]];
		writeFileSync(configPath, JSON.stringify(config));
		await runtime.refresh({ allowNetwork: false });
		const added = runtime.getModel("test", customId);
		assert.ok(added, "pool refresh must include newly configured account models");
		const addedResponse = await request(input(), {}, added).result();
		assert.equal(addedResponse.stopReason, "stop", addedResponse.errorMessage);

		const replacementToken = `header.${Buffer.from(JSON.stringify({ sub: "replacement-user", "https://api.openai.com/auth": { chatgpt_account_id: "shared-workspace" } })).toString("base64url")}.sig`;
		const replacementKey = accountKey(names[0], replacementToken);
		const getAuth = ModelRuntime.prototype.getAuth;
		let replaced = false;
		ModelRuntime.prototype.getAuth = async function (provider, ...args) {
			if (provider === names[0] && !replaced) {
				replaced = true;
				const credentials = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
				credentials[names[0]].access = replacementToken;
				writeFileSync(join(agentDir, "auth.json"), JSON.stringify(credentials));
			}
			return getAuth.call(this, provider, ...args);
		};
		try {
			await extension.commands.get("subs").handler("limits", ctx);
			assert.ok(replaced);
			const snapshot = state.snapshot();
			assert.ok(
				snapshot.accounts[primaryKey].blockedUntil > Date.now(),
				"replacement identity must not clear old account rejection",
			);
			assert.equal(snapshot.accounts[replacementKey].quota.kind, "ready");
		} finally {
			ModelRuntime.prototype.getAuth = getAuth;
			writeFileSync(join(agentDir, "auth.json"), credentialsBefore);
		}
	} finally {
		state.close();
		config.pools[0].members = names;
		config.pools.pop();
		config.chains = [];
		writeFileSync(configPath, JSON.stringify(config));
	}

	// RPC supports standard dialogs but not custom terminal components.
	const rpcProject = join(agentDir, "rpc-project");
	mkdirSync(join(rpcProject, ".pi"), { recursive: true });
	const projectPath = join(rpcProject, ".pi/multi-pass.json");
	writeFileSync(projectPath, "{}");
	const rpc = {
		...ctx,
		cwd: rpcProject,
		hasUI: true,
		mode: "rpc",
		ui: {
			...ctx.ui,
			custom() {
				throw new Error("RPC must not call terminal components");
			},
			select: async () => undefined,
		},
	};
	await extension.commands.get("subs").handler("list", rpc);
	await extension.commands.get("subs").handler("limits", rpc);
	rpc.ui.select = async (_title, choices) => choices.find((choice) => choice.startsWith("edit "));
	rpc.ui.editor = async () => JSON.stringify({ pools: ["test"] });
	await extension.commands.get("pool").handler("project", rpc);
	assert.deepEqual(JSON.parse(readFileSync(projectPath, "utf8")), { pools: ["test"] });
	rpc.ui.editor = async () => {
		writeFileSync(projectPath, JSON.stringify({ pools: ["test"], allowedSubs: [names[1]] }));
		return "{}";
	};
	await assert.rejects(extension.commands.get("pool").handler("project", rpc), /changed while editing/);
	assert.deepEqual(JSON.parse(readFileSync(projectPath, "utf8")).allowedSubs, [names[1]]);
	rpc.ui.editor = async () => "{invalid";
	await assert.rejects(extension.commands.get("pool").handler("project", rpc));
	assert.deepEqual(JSON.parse(readFileSync(projectPath, "utf8")).allowedSubs, [names[1]]);

	// Status pages expose useful state without duplicating limits or credential internals.
	const views = [];
	const compactUi = {
		...rpc.ui,
		select: async (title, choices) => {
			views.push({ title, choices });
			return undefined;
		},
	};
	const compactContext = { ...rpc, cwd, ui: compactUi };
	const displayState = new SharedPoolState(join(agentDir, "multi-pass.sqlite"));
	let displayLease;
	try {
		for (const name of names) displayState.succeed(accountKey(name, tokens.get(name)), Date.now() + 1);
		displayLease = displayState.reserve([{ provider: names[0], key: primaryKey }], 2);
		assert.ok(displayLease);
		displayState.fail(accountKey(names[1], tokens.get(names[1])), "synthetic private error", Date.now() + 60_000);
		await extension.commands.get("pool").handler("status", compactContext);
		const poolStatus = views.at(-1).choices;
		assert.equal(poolStatus.length, names.length + 1, "one heading and one line per member");
		assert.match(poolStatus[0], /test · enabled · round-robin · 2\/3 available/);
		assert.match(poolStatus[1], /available · 1\/2/);
		assert.match(poolStatus[2], /cooling down · 0\/2/);
		assert.doesNotMatch(poolStatus.join("\n"), /waiting|quota:|checked|last rejection|synthetic private error|until/);

		let openedPool = false;
		compactUi.select = async (title, choices) => {
			views.push({ title, choices });
			if (title === "Pools" && !openedPool) {
				openedPool = true;
				return choices.find((choice) => choice.startsWith("test "));
			}
			if (title === "test") return choices.find((choice) => choice.startsWith("inspect "));
			return undefined;
		};
		await extension.commands.get("pool").handler("list", compactContext);
		assert.deepEqual(views.find((view) => view.title === "Pool Status: test").choices, poolStatus);

		const scheduledStatus = structuredClone(config);
		scheduledStatus.pools[0].strategy = "scheduled";
		scheduledStatus.pools[0].memberSchedule = {
			[names[0]]: {
				role: "preferred",
				windows: [{ hours: [(new Date().getHours() + 1) % 24, (new Date().getHours() + 2) % 24] }],
			},
		};
		try {
			writeFileSync(configPath, JSON.stringify(scheduledStatus));
			await extension.commands.get("pool").handler("status", compactContext);
			assert.match(views.at(-1).choices[0], /1\/3 available/);
			assert.match(views.at(-1).choices[1], /outside schedule/);
		} finally {
			writeFileSync(configPath, JSON.stringify(config));
		}

		const damagedCredentials = JSON.parse(credentialsBefore);
		damagedCredentials[names[2]].access = "damaged";
		try {
			writeFileSync(join(agentDir, "auth.json"), JSON.stringify(damagedCredentials));
			await extension.commands.get("pool").handler("status", compactContext);
			assert.match(views.at(-1).choices[3], /invalid credential/);
		} finally {
			writeFileSync(join(agentDir, "auth.json"), credentialsBefore);
		}

		compactUi.select = async (title, choices) => {
			views.push({ title, choices });
			return undefined;
		};
		await extension.commands.get("pool").handler("", compactContext);
		assert.deepEqual(
			views.at(-1).choices.map((choice) => choice.split(" ")[0]),
			["create", "list", "chain", "project"],
		);
		await extension.commands.get("subs").handler("", compactContext);
		assert.deepEqual(
			views.at(-1).choices.map((choice) => choice.split(/\s|—/)[0]),
			["list", "add", "switch", "status", "limits"],
		);
		await extension.commands.get("subs").handler("status", compactContext);
		const accountStatus = views.at(-1).choices;
		assert.equal(accountStatus.length, names.length);
		assert.ok(accountStatus.every((line) => line.includes("logged in") && line.includes("test")));
		assert.doesNotMatch(accountStatus.join("\n"), /expires|expired|models|saved|\benv\b/);

		let inspectedLimit = false;
		compactUi.select = async (title, choices) => {
			views.push({ title, choices });
			if (title === "Subscription Limits" && !inspectedLimit) {
				inspectedLimit = true;
				return choices[0];
			}
			return undefined;
		};
		await extension.commands.get("subs").handler("limits", compactContext);
		const limitDetails = views.find((view) => view.title.startsWith("Limit Details:")).choices;
		assert.ok(limitDetails.some((line) => line.startsWith("5-hour window:")));
		assert.ok(limitDetails.some((line) => line.startsWith("7-day window:")));
		assert.doesNotMatch(limitDetails.join("\n"), /endpoint:|provider:|account:/);
	} finally {
		if (displayLease) displayState.release(displayLease.id);
		for (const name of names) displayState.succeed(accountKey(name, tokens.get(name)), Date.now() + 1);
		displayState.close();
	}

	const beforeCancel = readFileSync(configPath, "utf8");
	for (const strategy of [undefined, "scheduled"]) {
		let memberChosen = false;
		rpc.ui.input = async () => "cancelled-pool";
		rpc.ui.select = async (title, choices) => {
			if (title === "Pool base provider") return choices[0];
			if (title.startsWith("Add members")) {
				if (memberChosen) return "[Done - create pool]";
				memberChosen = true;
				return choices.find((choice) => choice.startsWith(names[0]));
			}
			if (title === "Selection strategy" && strategy) return choices.find((choice) => choice.startsWith(strategy));
			return undefined;
		};
		await extension.commands.get("pool").handler("create", rpc);
		assert.equal(readFileSync(configPath, "utf8"), beforeCancel);
	}

	// Strategy edits detect concurrent changes even when membership is unchanged.
	rpc.ui.select = async (title, choices) => {
		if (title === "Pools") return choices.find((choice) => choice.startsWith("test "));
		if (title === "test") return choices.find((choice) => choice.startsWith("strategy "));
		if (title.startsWith("Strategy:")) return choices.find((choice) => choice.startsWith("scheduled "));
		if (title.startsWith("Role for")) {
			const concurrent = JSON.parse(readFileSync(configPath, "utf8"));
			concurrent.pools[0].strategy = "quota-first";
			writeFileSync(configPath, JSON.stringify(concurrent));
			return choices[0];
		}
		return undefined;
	};
	try {
		await assert.rejects(extension.commands.get("pool").handler("list", rpc), /strategy or members changed/);
		assert.equal(JSON.parse(readFileSync(configPath, "utf8")).pools[0].strategy, "quota-first");
	} finally {
		writeFileSync(configPath, beforeCancel);
	}

	// Re-selecting scheduled permits editing its windows, and Escape preserves the result.
	config.pools[0].strategy = "scheduled";
	writeFileSync(configPath, JSON.stringify(config));
	let strategyOpened = false;
	rpc.ui.select = async (title, choices) => {
		if (title === "Pools") {
			if (strategyOpened) return undefined;
			strategyOpened = true;
			return choices.find((choice) => choice.startsWith("test "));
		}
		if (title === "test") return choices.find((choice) => choice.startsWith("strategy "));
		if (title.startsWith("Strategy:")) return choices.find((choice) => choice.startsWith("scheduled "));
		if (title === `Role for ${names[0]}`) return choices.find((choice) => choice.startsWith("preferred "));
		if (title.startsWith("Role for")) return choices[0];
		return undefined;
	};
	rpc.ui.input = async () => "22-6 mon-sun";
	await extension.commands.get("pool").handler("list", rpc);
	const scheduled = readFileSync(configPath, "utf8");
	assert.deepEqual(JSON.parse(scheduled).pools[0].memberSchedule[names[0]].windows[0].hours, [22, 6]);
	assert.equal(JSON.parse(scheduled).pools[0].memberSchedule[names[0]].windows[0].days.length, 7);
	rpc.ui.input = async () => undefined;
	strategyOpened = false;
	await extension.commands.get("pool").handler("list", rpc);
	assert.equal(readFileSync(configPath, "utf8"), scheduled);
	writeFileSync(configPath, beforeCancel);

	// Display punctuation and internal action names must not change the selected pool.
	const namedConfig = JSON.parse(beforeCancel);
	for (const name of ["work (team) -- backup", "__global__", "__done__"])
		namedConfig.pools.push({ name, baseProvider: "openai-codex", members: [names[1]], enabled: true });
	writeFileSync(configPath, JSON.stringify(namedConfig));
	writeFileSync(projectPath, "{}");
	for (const name of ["work (team) -- backup", "__global__"]) {
		rpc.ui.select = async (title, choices) =>
			title.startsWith("Project Config")
				? choices.find((choice) => choice.startsWith("pools "))
				: choices.find((choice) => choice.startsWith(`${name} — `));
		await extension.commands.get("pool").handler("project", rpc);
		assert.equal(JSON.parse(readFileSync(projectPath, "utf8")).pools.includes(name), false);
		await extension.commands.get("pool").handler("project", rpc);
		assert.equal(JSON.parse(readFileSync(projectPath, "utf8")).pools.includes(name), true);
	}
	let chosePool = false;
	rpc.ui.input = async () => "chain -- team";
	rpc.ui.confirm = async () => true;
	rpc.ui.select = async (title, choices) => {
		if (title === "Chain Manager") return choices[0];
		if (title === "Add chain entries") {
			if (chosePool) return choices.find((choice) => choice === "Done - save chain");
			chosePool = true;
			return choices.find((choice) => choice.startsWith("__done__ — "));
		}
		if (title.startsWith("Default model")) return choices[0];
		return undefined;
	};
	await extension.commands.get("pool").handler("chain", rpc);
	assert.equal(JSON.parse(readFileSync(configPath, "utf8")).chains.at(-1).entries[0].pool, "__done__");
	let inspectedChain = false;
	rpc.ui.select = async (title, choices) => {
		if (title === "Chain Manager") {
			assert.equal(
				choices.some((choice) => choice.startsWith("status ")),
				false,
			);
			return choices.find((choice) => choice.startsWith("list "));
		}
		if (title === "Chains") return choices.find((choice) => choice.startsWith("chain -- team — "));
		if (title === "Chain: chain -- team") {
			inspectedChain = true;
			assert.equal(choices.length, 2, "one chain heading and one ordered entry");
			assert.doesNotMatch(choices.join("\n"), /usable entries|invalid entries|chain state|authed/);
		}
		return undefined;
	};
	await extension.commands.get("pool").handler("chain", rpc);
	assert.equal(inspectedChain, true);
	let choseProvider = false;
	rpc.ui.input = async () => "preset -- team";
	rpc.ui.select = async (title, choices) => {
		if (title === "Add entry") {
			if (choseProvider) return choices.find((choice) => choice === "Done - save preset");
			choseProvider = true;
			return choices.find((choice) => choice.startsWith("work (team) -- backup — "));
		}
		if (title.startsWith("Model for")) return choices[0];
		return undefined;
	};
	await extension.commands.get("mp-preset").handler("create", rpc);
	assert.equal(
		JSON.parse(readFileSync(configPath, "utf8")).presets.at(-1).entries[0].provider,
		"work (team) -- backup",
	);
	writeFileSync(configPath, beforeCancel);
	writeFileSync(projectPath, "{}");

	const selector = join(agentDir, "failed-selector.mjs");
	writeFileSync(selector, "export default () => { throw new Error('synthetic selector failure'); };", { flag: "wx" });
	config.pools[0].strategy = "custom";
	config.pools[0].selectorScript = selector;
	writeFileSync(configPath, JSON.stringify(config));
	const warnings = [];
	const removeWarning = eventBus.on("multi-pass:warning", (message) => warnings.push(message));
	try {
		const selectedAfterWarning = await request().result();
		assert.equal(selectedAfterWarning.stopReason, "stop", selectedAfterWarning.errorMessage);
		assert.ok(
			warnings.some((message) => message.includes("synthetic selector failure") && message.includes("round-robin")),
		);
	} finally {
		removeWarning();
		config.pools[0].strategy = "round-robin";
		delete config.pools[0].selectorScript;
		writeFileSync(configPath, JSON.stringify(config));
	}

	// Configuration failure must precede destructive credential operations.
	rpc.ui.select = async (_title, choices) => choices[0];
	rpc.ui.confirm = async () => {
		writeFileSync(configPath, "{broken");
		return true;
	};
	try {
		await assert.rejects(extension.commands.get("subs").handler("remove", rpc), /Invalid configuration/);
		assert.equal(readFileSync(join(agentDir, "auth.json"), "utf8"), credentialsBefore);
	} finally {
		writeFileSync(configPath, beforeCancel);
	}

	// A re-login which wins the native credential lock invalidates the pending removal.
	const { FileAuthStorageBackend } = await import(pathToFileURL(join(piPackage, "dist/core/auth-storage.js")).href);
	const releaseAuth = Promise.withResolvers();
	const lockedAuth = Promise.withResolvers();
	const confirmedRemoval = Promise.withResolvers();
	const replacementCredentials = JSON.parse(credentialsBefore);
	replacementCredentials[names[0]].access = tokens.get(names[1]);
	const authWriter = new FileAuthStorageBackend().withLockAsync(async () => {
		lockedAuth.resolve();
		await releaseAuth.promise;
		return { result: undefined, next: JSON.stringify(replacementCredentials) };
	});
	await lockedAuth.promise;
	rpc.ui.confirm = async () => {
		confirmedRemoval.resolve();
		return true;
	};
	const pendingRemoval = extension.commands.get("subs").handler("remove", rpc);
	const rejectedRemoval = assert.rejects(pendingRemoval, /re-authenticated in another window/);
	await confirmedRemoval.promise;
	releaseAuth.resolve();
	await authWriter;
	await rejectedRemoval;
	assert.equal(readFileSync(configPath, "utf8"), beforeCancel);
	assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")), replacementCredentials);
	writeFileSync(join(agentDir, "auth.json"), credentialsBefore);

	// A stale confirmation must not remove a subsequently created subscription.
	const removalUi = { ...rpc.ui, confirm: async () => true };
	rpc.ui.confirm = async () => {
		await extension.commands.get("subs").handler("remove", { ...rpc, ui: removalUi });
		await extension.commands.get("subs").handler("add", {
			...rpc,
			ui: {
				...removalUi,
				input: async () => "replacement",
				confirm: async () => false,
			},
		});
		return true;
	};
	await assert.rejects(
		extension.commands.get("subs").handler("remove", rpc),
		/re-authenticated|changed in another window/,
	);
	const replacement = JSON.parse(readFileSync(configPath, "utf8")).subscriptions.find(
		(entry) => entry.label === "replacement",
	);
	assert.ok(replacement.index > Math.max(...subscriptions.map((entry) => entry.index)));
	assert.equal(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"))[names[0]], undefined);
	writeFileSync(configPath, beforeCancel);
	writeFileSync(join(agentDir, "auth.json"), credentialsBefore);

	// Disabled pools disappear from the registry without touching member accounts.
	config.pools[0].enabled = false;
	writeFileSync(configPath, JSON.stringify(config));
	await emit("before_agent_start", {});
	assert.equal(
		loaded.runtime.pendingNativeProviderRegistrations.some((entry) => entry.provider.id === "test"),
		false,
	);
	assert.equal(readFileSync(join(agentDir, "auth.json"), "utf8"), credentialsBefore);
	await emit("session_shutdown", {});
	console.log(
		"native pool discovery, inherited child providers, independent thinking, concurrency, cancellation, in-request failover, quota deduplication, and disable checks passed",
	);
} finally {
	globalThis.fetch = previousFetch;
	for (const resolve of waitingResolvers) resolve();
}
