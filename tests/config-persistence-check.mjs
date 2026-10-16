import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	addSubscription,
	removeSubscription,
	normalizeMultiPassConfig,
	normalizeProjectConfig,
	readConfig,
	updateConfig,
	writeJsonAtomic,
} from "../src/config.mts";
import { SharedPoolState } from "../src/shared-state.mts";

if (process.argv[2] === "--writer") {
	const state = new SharedPoolState(join(process.argv[3], "state.sqlite"));
	for (let index = 0; index < 10; index++)
		updateConfig(state, join(process.argv[3], "multi-pass.json"), normalizeMultiPassConfig, (config) => {
			config.maxRetries++;
		});
	state.close();
} else {
	const directory = mkdtempSync(join(tmpdir(), "multi-pass-config-"));
	const path = join(directory, "multi-pass.json");
	const state = new SharedPoolState(join(directory, "state.sqlite"));
	try {
		assert.equal(readConfig(path, normalizeMultiPassConfig), undefined);
		updateConfig(state, path, normalizeMultiPassConfig, (config) => {
			config.subscriptions.push({ provider: "openai-codex", index: 2, label: "initial" });
		});
		const stale = readConfig(path, normalizeMultiPassConfig);
		updateConfig(state, path, normalizeMultiPassConfig, (config) => {
			config.maxConcurrentPerAccount = 4;
		});
		updateConfig(state, path, normalizeMultiPassConfig, (config) => {
			config.subscriptions.find((entry) => entry.index === stale.subscriptions[0].index).label = "renamed";
		});
		assert.equal(readConfig(path, normalizeMultiPassConfig).maxConcurrentPerAccount, 4);
		await Promise.all(
			Array.from(
				{ length: 8 },
				() =>
					new Promise((resolve, reject) => {
						const child = fork(fileURLToPath(import.meta.url), ["--writer", directory], { stdio: "inherit" });
						child.once("error", reject);
						child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Writer exited with ${code}`))));
					}),
			),
		);
		assert.equal(readConfig(path, normalizeMultiPassConfig).maxRetries, 83);
		for (const source of ["{broken", "null", "[]", '{"pools":null}', '{"maxConcurrentPerAccount":0}']) {
			writeFileSync(path, source);
			assert.throws(
				() =>
					updateConfig(state, path, normalizeMultiPassConfig, (config) => {
						config.maxRetries = 0;
					}),
				/Invalid configuration/,
			);
			assert.equal(readFileSync(path, "utf8"), source, "invalid config must never be replaced by defaults");
		}
		const projectPath = join(directory, "project.json");
		writeJsonAtomic(projectPath, { allowedSubs: ["openai-codex-2"] });
		updateConfig(state, projectPath, normalizeProjectConfig, (project) => {
			project.pools = [];
		});
		assert.deepEqual(readConfig(projectPath, normalizeProjectConfig).allowedSubs, ["openai-codex-2"]);
		writeFileSync(projectPath, '{"allowedSubs":["misspelled"]}');
		assert.throws(() => readConfig(projectPath, normalizeProjectConfig), /allowedSubs/);
		assert.throws(() => normalizeMultiPassConfig({ subscriptions: [{ provider: "unknown", index: 2 }] }));
		assert.equal(normalizeMultiPassConfig({ maxRetries: 0 }).maxRetries, 0);
		const subscriptions = normalizeMultiPassConfig({
			subscriptions: [
				{ provider: "openai-codex", index: 2, label: "old" },
				{ provider: "openai-codex", index: 4, label: "last" },
			],
		});
		const staleSubscription = structuredClone(subscriptions.subscriptions[0]);
		removeSubscription(subscriptions, staleSubscription);
		removeSubscription(subscriptions, subscriptions.subscriptions[0]);
		const next = addSubscription(subscriptions, "new");
		assert.equal(next.index, 5, "removed numbers must not be assigned again");
		assert.throws(() => removeSubscription(subscriptions, staleSubscription), /changed in another window/);
		assert.equal(subscriptions.subscriptions[0].label, "new");
		assert.equal(addSubscription(normalizeMultiPassConfig(subscriptions), "newer").index, 6);
		const occupied = join(directory, "occupied");
		mkdirSync(occupied);
		writeFileSync(join(occupied, "keep.txt"), "keep");
		assert.throws(() => writeJsonAtomic(occupied, {}));
		assert.equal(readFileSync(join(occupied, "keep.txt"), "utf8"), "keep");
		assert.equal(readdirSync(directory).filter((file) => file.endsWith(".tmp")).length, 0);
	} finally {
		state.close();
	}
	console.log("production config locking, concurrent writers, validation and atomic writes checks passed");
}
