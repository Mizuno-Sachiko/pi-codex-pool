import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SharedPoolState, activeRequests } from "../src/shared-state.mts";

const members = ["a", "b", "c"].map((provider) => ({
	provider,
	key: provider,
}));

if (process.argv[2] === "--reserve") {
	const shared = new SharedPoolState(process.argv[3]);
	const lease = shared.reserve(members, 2, "pool");
	process.send({ lease });
	process.once("message", () => {
		if (lease) shared.release(lease.id);
		shared.close();
		process.disconnect();
	});
} else {
	const directory = mkdtempSync(join(tmpdir(), "multi-pass-round-robin-"));
	const path = join(directory, "state.sqlite");
	const first = new SharedPoolState(path);
	const second = new SharedPoolState(path);
	const selected = [];
	for (let index = 0; index < 6; index++) {
		const shared = index % 2 ? first : second;
		const lease = shared.reserve(members, 2, "pool");
		assert.ok(lease);
		selected.push(lease);
	}
	assert.deepEqual(
		selected.map((lease) => lease.provider),
		["a", "b", "c", "a", "b", "c"],
	);
	assert.equal(second.reserve(members, 2, "pool"), undefined);
	for (const lease of selected) first.release(lease.id);

	// Load balancing takes precedence over the cursor, and aliases share the same cap.
	const busy = first.reserve([members[0]], 2);
	assert.ok(busy);
	const idle = second.reserve(members, 2, "pool");
	assert.equal(idle.provider, "b");
	assert.ok(first.reserve([{ provider: "alias-a", key: "a" }], 2));
	assert.equal(second.reserve([{ provider: "another-alias-a", key: "a" }], 2), undefined);
	for (const lease of Object.values(first.snapshot().leases)) first.release(lease.id);

	const children = Array.from({ length: 12 }, () =>
		fork(fileURLToPath(import.meta.url), ["--reserve", path], {
			stdio: ["ignore", "ignore", "inherit", "ipc"],
		}),
	);
	const replies = await Promise.all(
		children.map(
			(child) =>
				new Promise((resolve, reject) => {
					child.once("message", resolve);
					child.once("error", reject);
					child.once("exit", (code) => {
						if (code) reject(new Error(`Worker exited with ${code}`));
					});
				}),
		),
	);
	const exitPromises = children.map(
		(child) =>
			new Promise((resolve, reject) => {
				child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Worker exited with ${code}`))));
			}),
	);
	try {
		assert.equal(replies.filter((reply) => reply.lease).length, 6);
		const state = first.snapshot();
		for (const member of members) assert.equal(activeRequests(state, member.key), 2);
	} finally {
		for (const child of children) child.send("release");
		await Promise.all(exitPromises);
		first.close();
		second.close();
	}

	const source = readFileSync(new URL("../extensions/multi-sub.ts", import.meta.url), "utf8");
	assert.match(source, /new PoolRouter\(/);
	assert.doesNotMatch(source, /poolManager\.startTurn\(|shared\.commit\(/);
	const fair = new SharedPoolState(join(directory, "fair.sqlite"));
	const held = fair.reserve([members[0]], 1);
	assert.equal(fair.reserve([members[0]], 1, "pool", "older"), undefined);
	assert.equal(fair.reserve([members[0]], 1, "another", "newer"), undefined);
	fair.release(held.id);
	assert.equal(fair.reserve([members[0]], 1, "another", "newer"), undefined);
	const admitted = fair.reserve([members[0]], 1, "pool", "older");
	assert.ok(admitted, "the earlier waiter must acquire the released slot");
	fair.cancelWait("newer");
	fair.release(admitted.id);
	assert.equal(Object.keys(fair.snapshot().waiters).length, 0);
	fair.close();
	assert.doesNotMatch(source, /sendUserMessage\(lastUserPrompt/);
	console.log("shared round-robin and multi-process concurrency checks passed");
}
