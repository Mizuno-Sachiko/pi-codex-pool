import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { selectCustomMember } from "../src/selector.mts";
import { SharedPoolState } from "../src/shared-state.mts";

const directory = mkdtempSync(join(tmpdir(), "pool-selector-"));
const pool = { name: "synthetic", baseProvider: "openai-codex", members: ["a", "b"], enabled: true };
const select = (name, signal = new AbortController().signal) =>
	selectCustomMember(join(directory, name), pool, pool.members, "model", signal);
writeFileSync(join(directory, "valid.mjs"), "export default ({members}) => [members[1], members[0]];");
assert.deepEqual(await select("valid.mjs"), ["b", "a"]);
await assert.rejects(select("missing.mjs"), /ENOENT/);
writeFileSync(join(directory, "missing.mjs"), "export default () => 'a';");
assert.deepEqual(await select("missing.mjs"), ["a", "b"], "missing files must not be negatively cached");
writeFileSync(
	join(directory, "throws.mjs"),
	"export default () => { throw new Error('synthetic selector failure'); };",
);
await assert.rejects(select("throws.mjs"), /synthetic selector failure/);
writeFileSync(join(directory, "invalid.mjs"), "export default () => 'outside-pool';");
await assert.rejects(select("invalid.mjs"), /no eligible account/);
pool.members = ["a", "b", "c"];
writeFileSync(join(directory, "ordered.mjs"), "export default () => ['c', 'b', 'b', 'outside-pool', 'a'];");
const ordered = await select("ordered.mjs");
assert.deepEqual(ordered, ["c", "b", "a"]);
const state = new SharedPoolState(join(directory, "order.sqlite"));
try {
	state.fail("c", "synthetic cooldown", Date.now() + 60_000);
	assert.equal(
		state.reserve(
			ordered.map((provider) => ({ provider, key: provider })),
			2,
			undefined,
			undefined,
			true,
		).provider,
		"b",
	);
} finally {
	state.close();
}
writeFileSync(join(directory, "pending.mjs"), "export default () => new Promise(() => {});");
const controller = new AbortController();
const pending = select("pending.mjs", controller.signal);
await wait(20);
controller.abort();
await assert.rejects(pending, { name: "AbortError" });
console.log("custom selector file URLs, failures, corrected files and cancellation checks passed");
