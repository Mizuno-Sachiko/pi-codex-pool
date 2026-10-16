import assert from "node:assert/strict";
import {
	buildEffectiveConfig,
	normalizeMultiPassConfig,
	normalizeProjectConfig,
	parseEnvConfig,
	subProviderName,
} from "../src/config.mts";

const global = normalizeMultiPassConfig({
	subscriptions: [{ provider: "openai-codex", index: 2, label: "work" }],
	pools: [
		{ name: "work", baseProvider: "openai-codex", members: ["openai-codex", "openai-codex-2"], enabled: true },
		{ name: "backup", baseProvider: "openai-codex", members: ["openai-codex-3"], enabled: true },
	],
	chains: [
		{
			name: "primary",
			enabled: true,
			entries: [
				{ pool: "work", model: "model-a", enabled: true },
				{ pool: "backup", model: "model-a", enabled: true },
			],
		},
	],
});
const restricted = buildEffectiveConfig(global, normalizeProjectConfig({ allowedSubs: ["openai-codex-2"] }));
assert.deepEqual(restricted.subscriptions.map(subProviderName), ["openai-codex-2"]);
assert.deepEqual(
	restricted.pools.map((pool) => pool.members),
	[["openai-codex-2"]],
);
assert.deepEqual(
	restricted.chains[0].entries.map((entry) => entry.pool),
	["work"],
);
assert.equal(global.pools[0].members.length, 2, "project filtering must not mutate the global pool");
const base = buildEffectiveConfig(global, normalizeProjectConfig({ allowedSubs: ["openai-codex"] }));
assert.deepEqual(base.subscriptions, []);
assert.deepEqual(base.pools[0].members, ["openai-codex"]);
const env = buildEffectiveConfig(normalizeMultiPassConfig({}), undefined, parseEnvConfig("openai-codex:3"));
assert.deepEqual(env.subscriptions.map(subProviderName), ["openai-codex-2", "openai-codex-3", "openai-codex-4"]);
assert.deepEqual(buildEffectiveConfig(global, normalizeProjectConfig({ pools: [] })).pools, []);
for (const invalid of [
	null,
	[],
	{ allowedSubs: "openai-codex-2" },
	{ allowedSubs: ["typo"] },
	{ allowedSubs: [null] },
	{ pools: null },
]) {
	assert.throws(() => normalizeProjectConfig(invalid));
}
const project = normalizeProjectConfig({
	pools: [{ ...global.pools[0], strategy: "custom", selectorScript: "private.js" }],
});
assert.equal(project.pools[0].selectorScript, undefined);
const references = normalizeProjectConfig({ pools: ["work"] });
assert.deepEqual(buildEffectiveConfig(global, references).pools[0].members, global.pools[0].members);
global.pools[0].strategy = "quota-first";
global.pools[0].members = ["openai-codex-2"];
assert.equal(buildEffectiveConfig(global, references).pools[0].strategy, "quota-first");
assert.deepEqual(buildEffectiveConfig(global, references).pools[0].members, ["openai-codex-2"]);
assert.equal(
	buildEffectiveConfig(global, project).pools[0].strategy,
	"custom",
	"explicit project definitions remain independent",
);
assert.throws(() => normalizeProjectConfig({ pools: ["work", "work"] }), /duplicate/);
console.log("production project validation, account restrictions and environment merge checks passed");
