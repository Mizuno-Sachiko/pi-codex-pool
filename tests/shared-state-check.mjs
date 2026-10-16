import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedPoolState, unavailableUntil } from "../src/shared-state.mts";

const directory = mkdtempSync(join(tmpdir(), "multi-pass-state-"));
const path = join(directory, "state.sqlite");
const first = new SharedPoolState(path);
const second = new SharedPoolState(path);
const members = [{ provider: "a", key: "a" }];
const realNow = Date.now;
let now = realNow();
Date.now = () => now;
const quota = (kind, checkedAt = now) => ({
	kind,
	checkedAt,
	score: 80,
	summary: kind,
	details: [],
});
function saveQuota(state, key, value) {
	const refresh = state.beginRefresh(key, 0);
	assert.equal(typeof refresh, "object");
	state.finishRefresh(key, refresh.id, value);
}
try {
	first.fail("a", "temporary rejection", now + 30_000, now + 99 * 60_000);
	assert.equal(second.reserve(members, 2), undefined);
	now++;
	saveQuota(first, "a", quota("ready"));
	assert.equal(first.snapshot().accounts.a.blockedUntil, undefined);
	assert.equal(second.reserve(members, 2), undefined, "quota recovery must retain the live request cooldown");
	now += 30_000;
	const probe = first.reserve(members, 2);
	assert.ok(probe);
	assert.equal(second.reserve(members, 2), undefined, "only one recovery probe is allowed across processes");
	first.succeed("a", now);
	first.release(probe.id);
	const one = first.reserve(members, 2);
	const two = second.reserve(members, 2);
	assert.ok(one);
	assert.ok(two);
	assert.equal(first.reserve(members, 2), undefined);
	first.release(one.id);
	second.release(two.id);

	const oldRequest = now;
	now++;
	second.fail("a", "newer rejection", now + 30_000, now + 60_000);
	first.succeed("a", oldRequest);
	assert.ok(unavailableUntil(first.snapshot().accounts.a, now) > now);
	saveQuota(first, "a", quota("ready", oldRequest));
	assert.ok(first.snapshot().accounts.a.blockedUntil > now, "stale snapshots must not clear a later rejection");
	saveQuota(first, "a", quota("error"));
	assert.ok(first.snapshot().accounts.a.blockedUntil > now, "query errors must not make exhausted accounts available");

	const refreshB = first.beginRefresh("b", 60_000);
	assert.equal(typeof refreshB, "object");
	now += 12_000;
	assert.equal(second.beginRefresh("b", 60_000), "pending");
	first.finishRefresh("b", refreshB.id, quota("ready"));
	assert.equal(second.beginRefresh("b", 60_000), "cached");
	assert.equal(second.beginRefresh("b", 10_000), "cached", "a slow completed lookup must still be shared");
	now += 10_000;
	const manualB = second.beginRefresh("b", 10_000);
	assert.equal(typeof manualB, "object", "manual checks can refresh after ten seconds");
	second.finishRefresh("b", manualB.id, quota("ready"));
	assert.equal(first.beginRefresh("b", 60_000), "cached");
	now += 60_000;
	const automaticB = first.beginRefresh("b", 60_000);
	assert.equal(typeof automaticB, "object");
	first.finishRefresh("b", automaticB.id, quota("ready"));

	const staleCheck = now;
	now++;
	first.succeed("fresh", now);
	saveQuota(second, "fresh", {
		...quota("blocked", staleCheck),
		resetAt: (now + 60_000) / 1000,
	});
	assert.equal(
		first.snapshot().accounts.fresh.blockedUntil,
		undefined,
		"a stale snapshot must not re-ban a recovered account",
	);

	const oldRefresh = first.beginRefresh("owner", 10_000);
	now += 31_000;
	const newRefresh = second.beginRefresh("owner", 10_000);
	assert.equal(typeof newRefresh, "object");
	first.finishRefresh("owner", oldRefresh.id, quota("ready", oldRefresh.startedAt));
	assert.equal(first.snapshot().refreshes.owner.pending, true);
	now += 11_000;
	assert.equal(first.beginRefresh("owner", 10_000), "pending");
	second.finishRefresh("owner", newRefresh.id, quota("ready", newRefresh.startedAt));

	const stale = first.beginRefresh("later", 0);
	now++;
	first.fail("later", "new refusal", now + 30_000, now + 3_600_000);
	const blockedUntil = first.snapshot().accounts.later.blockedUntil;
	first.finishRefresh("later", stale.id, quota("blocked", stale.startedAt));
	assert.equal(first.snapshot().accounts.later.blockedUntil, blockedUntil);

	first.fail("probe", "old refusal", now);
	const recoveryStarted = now;
	now++;
	saveQuota(second, "probe", quota("ready"));
	first.succeed("probe", recoveryStarted);
	assert.equal(first.snapshot().accounts.probe.needsProbe, undefined, "a newer ready result cannot prevent recovery");

	const lease = first.reserve([{ provider: "c", key: "c" }], 2);
	assert.ok(lease);
	now += 30_000;
	first.renew(lease.id);
	now += 100_000;
	assert.ok(second.snapshot().leases[lease.id], "active requests retain their renewed reservation");
	now += 21_000;
	assert.equal(second.snapshot().leases[lease.id], undefined, "abandoned reservations expire");
} finally {
	Date.now = realNow;
	first.close();
	second.close();
}

const deadPath = join(directory, "dead-process.sqlite");
const worker = spawnSync(
	process.execPath,
	[
		"--input-type=module",
		"--eval",
		`
	import { SharedPoolState } from ${JSON.stringify(new URL("../src/shared-state.mts", import.meta.url).href)};
	const shared = new SharedPoolState(${JSON.stringify(deadPath)});
	shared.reserve([{ provider: "a", key: "a" }], 1);
	shared.close();
`,
	],
	{ encoding: "utf8" },
);
assert.equal(worker.status, 0, worker.stderr);
const recovered = new SharedPoolState(deadPath);
assert.ok(recovered.reserve(members, 1), "an exited owner's reservation must be reclaimed without waiting for expiry");
recovered.close();
console.log("shared cooldown, recovery, refresh deduplication, and abandoned request checks passed");
