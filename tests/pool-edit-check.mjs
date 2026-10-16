import assert from "node:assert/strict";
import {
	normalizeMultiPassConfig,
	renamePoolReferences,
	pruneRemovedPoolReferences,
	requireNamed,
	replaceNamed,
} from "../src/config.mts";
import { getScheduledMemberOrder, parseScheduleWindowInput } from "../src/schedule.mts";

const pool = { name: "work", baseProvider: "openai-codex", members: ["openai-codex-2"], enabled: true };
assert.throws(() => normalizeMultiPassConfig({ pools: [{ ...pool, members: [] }] }));
assert.deepEqual(normalizeMultiPassConfig({ pools: [pool] }).pools[0], pool);
const chains = [
	{
		name: "primary",
		enabled: true,
		entries: [
			{ pool: "work", model: "model-a", enabled: true },
			{ pool: "backup", model: "model-a", enabled: true },
		],
	},
	{ name: "secondary", enabled: true, entries: [{ pool: "work", model: "model-b", enabled: true }] },
];
assert.equal(renamePoolReferences(chains, "work", "office"), 2);
assert.equal(chains[0].entries[0].pool, "office");
const result = pruneRemovedPoolReferences(chains, new Set(["office"]));
assert.equal(result.removedEntries, 2);
assert.equal(result.removedChains, 1);
assert.deepEqual(
	result.chains[0].entries.map((entry) => entry.pool),
	["backup"],
);
assert.throws(() => requireNamed([pool], "removed"), /no longer exists/);
const replacement = { ...pool, strategy: "quota-first" };
const entries = [structuredClone(pool)];
assert.equal(replaceNamed(entries, replacement, pool), "updated");
assert.throws(() => replaceNamed(entries, pool, pool), /changed in another window/);
assert.throws(() => replaceNamed(entries, pool, undefined), /changed in another window/);
assert.equal(entries[0], replacement, "a stale dialog must leave the newer entry unchanged");
assert.deepEqual(parseScheduleWindowInput("mon-sun").days, ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
assert.deepEqual(parseScheduleWindowInput("fri-mon").days, ["fri", "sat", "sun", "mon"]);
assert.deepEqual(parseScheduleWindowInput("sun-sun").days, ["sun"]);
assert.deepEqual(parseScheduleWindowInput("22-6 mon-fri sun").hours, [22, 6]);
for (const invalid of [
	"25-7 mon-fri",
	"9-17 typo",
	"mon-fry",
	"9-9",
	"2025-02-30..2025-03-01",
	"2025-03-02..2025-03-01",
])
	assert.equal(parseScheduleWindowInput(invalid), null);
const scheduled = {
	...pool,
	members: ["preferred", "default", "overflow"],
	memberSchedule: {
		preferred: { role: "preferred", windows: [parseScheduleWindowInput("9-17 mon-sun")] },
		overflow: { role: "overflow" },
	},
};
assert.deepEqual(getScheduledMemberOrder(scheduled, scheduled.members, new Date(2025, 0, 6, 12)), scheduled.members);
assert.deepEqual(getScheduledMemberOrder(scheduled, scheduled.members, new Date(2025, 0, 6, 18)), [
	"default",
	"overflow",
]);
console.log("production pool references and schedule parsing checks passed");
