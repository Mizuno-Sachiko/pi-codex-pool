import assert from "node:assert/strict";
import {
	isCodexProviderName,
	normalizeMultiPassConfig,
	normalizeProjectConfig,
	parseEnvConfig,
} from "../src/config.mts";

assert.equal(isCodexProviderName("openai-codex"), true);
assert.equal(isCodexProviderName("openai-codex-2"), true);
for (const name of ["unrelated", "openai-codex-1", "openai-codex-0", "openai-codex-two", "openai-codex-02"])
	assert.equal(isCodexProviderName(name), false);
assert.throws(() => normalizeMultiPassConfig({ subscriptions: [{ provider: "unrelated", index: 2 }] }));
assert.throws(() =>
	normalizeMultiPassConfig({
		pools: [{ name: "unrelated", baseProvider: "unrelated", members: ["openai-codex-2"], enabled: true }],
	}),
);
assert.throws(() => normalizeProjectConfig({ allowedSubs: ["unrelated"] }));
assert.throws(() => parseEnvConfig("unrelated:2"));
console.log("production Codex-only configuration boundary checks passed");
