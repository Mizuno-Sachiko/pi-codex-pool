import assert from "node:assert/strict";
import {
	accountProviders,
	buildEffectiveConfig,
	normalizeMultiPassConfig,
	normalizeProjectConfig,
} from "../src/config.mts";
import { selectAccountModel, buildPoolModels, validateVirtualPoolConfig } from "../src/models.mts";

const config = normalizeMultiPassConfig({ subscriptions: [{ provider: "openai-codex", index: 2 }] });
assert.deepEqual(
	accountProviders(buildEffectiveConfig(config, normalizeProjectConfig({ allowedSubs: ["openai-codex-2"] }))),
	["openai-codex-2"],
);
const models = [{ id: "model-a" }, { id: "model-b" }];
assert.equal(selectAccountModel(models, "model-b"), models[1]);
assert.equal(selectAccountModel(models, "removed"), models[0]);
assert.equal(selectAccountModel([], "removed"), undefined);
const member = { id: "model-a", name: "Model A", provider: "openai-codex-2", thinkingLevelMap: { low: "low" } };
const pool = buildPoolModels({ name: "pool", baseProvider: "openai-codex", members: [member.provider] }, () => [
	member,
]);
pool[0].thinkingLevelMap.low = "high";
assert.equal(member.thinkingLevelMap.low, "low", "pool metadata must not mutate account models");
assert.equal(pool[0].provider, "pool");
assert.doesNotThrow(() => validateVirtualPoolConfig("pool", undefined));
assert.doesNotThrow(() =>
	validateVirtualPoolConfig("pool", {
		modelOverrides: { "model-a": { contextWindow: 64000 } },
	}),
);
for (const definition of [{ id: "model-a" }, { id: "model-a", headers: { "x-pool": "synthetic" } }]) {
	assert.throws(() => validateVirtualPoolConfig("pool", { models: [definition] }), /modelOverrides/);
}
assert.doesNotThrow(() =>
	validateVirtualPoolConfig("pool", {
		api: "openai-codex-responses",
		baseUrl: "https://example.invalid",
		models: [{ id: "model-a" }],
	}),
);
assert.doesNotThrow(() =>
	validateVirtualPoolConfig("pool", {
		models: [
			{
				id: "model-a",
				api: "openai-codex-responses",
				baseUrl: "https://example.invalid",
			},
		],
	}),
);
console.log("production model selection and pool metadata isolation checks passed");
