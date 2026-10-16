import assert from "node:assert/strict";
import {
	accountProviders,
	buildEffectiveConfig,
	normalizeMultiPassConfig,
	normalizeProjectConfig,
} from "../src/config.mts";

const config = normalizeMultiPassConfig({ subscriptions: [{ provider: "openai-codex", index: 2 }] });
for (const allowedSubs of [["openai-codex-2"], ["openai-codex"], []]) {
	const effective = buildEffectiveConfig(config, normalizeProjectConfig({ allowedSubs }));
	assert.deepEqual(accountProviders(effective), allowedSubs.length ? allowedSubs : ["openai-codex", "openai-codex-2"]);
}
assert.deepEqual(accountProviders(buildEffectiveConfig(config), false), ["openai-codex-2"]);
assert.deepEqual(
	accountProviders(buildEffectiveConfig(config, normalizeProjectConfig({ allowedSubs: ["openai-codex-99"] }))),
	[],
);
console.log("production quota-account filtering checks passed");
