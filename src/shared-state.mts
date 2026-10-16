import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface StoredQuota {
	checkedAt: number;
	kind: "ready" | "watch" | "low" | "blocked" | "error" | "missing-auth";
	summary: string;
	details: string[];
	score: number;
	resetAt?: number;
}

export interface AccountState {
	quota?: StoredQuota;
	blockedUntil?: number;
	blockedAt?: number;
	cooldownUntil?: number;
	failureAt?: number;
	failure?: string;
	needsProbe?: boolean;
	lastSuccessfulCheckAt?: number;
	successfulRequestAt?: number;
}

export interface Member {
	provider: string;
	key: string;
}

export interface RequestLease extends Member {
	id: string;
	pid: number;
	expiresAt: number;
}

export interface RefreshLease {
	id: string;
	startedAt: number;
}

interface RefreshState extends RefreshLease {
	finishedAt?: number;
	pid: number;
	pending: boolean;
}

interface WaitingRequest {
	keys: string[];
	pid: number;
	expiresAt: number;
}

export interface PoolSnapshot {
	waiters?: Record<string, WaitingRequest>;
	accounts: Record<string, AccountState>;
	cursors: Record<string, string>;
	leases: Record<string, RequestLease>;
	refreshes: Record<string, RefreshState>;
}

function processExists(pid: number): boolean {
	try {
		// Signal zero checks ownership without signalling or terminating the process.
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

export function unavailableUntil(account: AccountState | undefined, now = Date.now()): number {
	return Math.max(now, account?.blockedUntil ?? 0, account?.cooldownUntil ?? 0);
}

export function activeRequests(state: PoolSnapshot, key: string): number {
	return Object.values(state.leases).filter((lease) => lease.key === key).length;
}

/** Transactions cover selection and reservation together, including other Pi processes. */
export class SharedPoolState {
	private database: DatabaseSync;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.database = new DatabaseSync(path, { timeout: 2000 });
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS pool_state (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
			INSERT OR IGNORE INTO pool_state VALUES (1, '{"accounts":{},"cursors":{},"leases":{},"refreshes":{}}');
		`);
	}

	withLock<T>(operation: () => T): T {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	private update<T>(change: (state: PoolSnapshot) => T): T {
		return this.withLock(() => {
			const row = this.database.prepare("SELECT data FROM pool_state WHERE id = 1").get();
			if (typeof row?.data !== "string") throw new Error("Shared pool state is missing");
			const original = row.data;
			const state = JSON.parse(original) as PoolSnapshot;
			const now = Date.now();
			for (const [id, lease] of Object.entries(state.leases)) {
				if (lease.expiresAt <= now || !processExists(lease.pid)) delete state.leases[id];
			}
			for (const [id, waiter] of Object.entries(state.waiters ?? {})) {
				if (waiter.expiresAt <= now || !processExists(waiter.pid)) delete state.waiters?.[id];
			}
			const result = change(state);
			const data = JSON.stringify(state);
			if (data !== original) {
				this.database.prepare("UPDATE pool_state SET data = ? WHERE id = 1").run(data);
			}
			return result;
		});
	}

	snapshot(): PoolSnapshot {
		return this.update((state) => state);
	}

	reserve(
		members: Member[],
		limit: number,
		pool?: string,
		requestId?: string,
		ordered = false,
	): RequestLease | undefined {
		return this.update((state) => {
			const now = Date.now();
			state.waiters ??= {};
			const waiters = state.waiters;
			if (requestId) {
				waiters[requestId] = {
					keys: members.map((member) => member.key),
					pid: process.pid,
					expiresAt: now + 120_000,
				};
			}
			const earlier: WaitingRequest[] = [];
			for (const [id, waiter] of Object.entries(waiters)) {
				if (id === requestId) break;
				earlier.push(waiter);
			}
			const cursor = pool ? members.findIndex((member) => member.provider === state.cursors[pool]) : -1;
			const orderedMembers = [...members.slice(cursor + 1), ...members.slice(0, cursor + 1)];
			let selected: Member | undefined;
			let fewest = limit;
			for (const member of orderedMembers) {
				if (earlier.some((waiter) => waiter.keys.includes(member.key))) continue;
				const account = state.accounts[member.key];
				if (unavailableUntil(account, now) > now) continue;
				const count = activeRequests(state, member.key);
				if (account?.needsProbe && count >= 1) continue;
				if (count < fewest) {
					selected = member;
					fewest = count;
					if (ordered) break;
				}
			}
			if (!selected) return undefined;
			const lease: RequestLease = {
				...selected,
				id: randomUUID(),
				pid: process.pid,
				expiresAt: now + 120_000,
			};
			state.leases[lease.id] = lease;
			if (pool) state.cursors[pool] = selected.provider;
			if (requestId) delete waiters[requestId];
			return lease;
		});
	}

	cancelWait(requestId: string): void {
		this.update((state) => {
			delete state.waiters?.[requestId];
		});
	}

	renew(id: string): void {
		this.update((state) => {
			const lease = state.leases[id];
			if (!lease) throw new Error("Account request reservation expired");
			lease.expiresAt = Date.now() + 120_000;
		});
	}

	release(id: string): void {
		this.update((state) => {
			delete state.leases[id];
		});
	}

	fail(key: string, message: string, cooldownUntil: number, blockedUntil?: number): void {
		this.update((state) => {
			state.accounts[key] ??= {};
			const account = state.accounts[key];
			account.needsProbe = true;
			account.failureAt = Date.now();
			account.failure = message;
			account.cooldownUntil = Math.max(account.cooldownUntil ?? 0, cooldownUntil);
			if (blockedUntil !== undefined) {
				account.blockedUntil = Math.max(account.blockedUntil ?? 0, blockedUntil);
				account.blockedAt = account.failureAt;
			}
		});
	}

	succeed(key: string, startedAt: number): void {
		this.update((state) => {
			state.accounts[key] ??= {};
			const account = state.accounts[key];
			account.successfulRequestAt = Math.max(account.successfulRequestAt ?? 0, startedAt);
			// Only newer rejection evidence can prevent a successful recovery.
			if (Math.max(account.failureAt ?? 0, account.blockedAt ?? 0) > startedAt) return;
			delete account.needsProbe;
			delete account.blockedUntil;
			delete account.blockedAt;
			delete account.cooldownUntil;
			delete account.failure;
			delete account.failureAt;
		});
	}

	beginRefresh(key: string, minimumInterval: number): RefreshLease | "pending" | "cached" {
		return this.update((state) => {
			const current = state.refreshes[key];
			const now = Date.now();
			if (current?.pending && now - current.startedAt < 30_000 && processExists(current.pid)) return "pending";
			if (current && !current.pending && now - (current.finishedAt ?? current.startedAt) < minimumInterval)
				return "cached";
			const lease = { id: randomUUID(), startedAt: now };
			state.refreshes[key] = { ...lease, pid: process.pid, pending: true };
			return lease;
		});
	}

	finishRefresh(key: string, id: string, quota?: StoredQuota): void {
		this.update((state) => {
			const refresh = state.refreshes[key];
			// An expired owner cannot finish or overwrite its successor's lookup.
			if (!refresh?.pending || refresh.id !== id) return;
			refresh.pending = false;
			refresh.finishedAt = Date.now();
			if (!quota) return;
			state.accounts[key] ??= {};
			const account = state.accounts[key];
			if ((account.quota?.checkedAt ?? 0) > quota.checkedAt) return;
			account.quota = quota;
			if (quota.kind === "error" || quota.kind === "missing-auth") return;
			account.lastSuccessfulCheckAt = quota.checkedAt;
			if (Math.max(account.successfulRequestAt ?? 0, account.failureAt ?? 0, account.blockedAt ?? 0) > quota.checkedAt)
				return;
			if (quota.kind === "blocked") {
				account.needsProbe = true;
				account.blockedAt = quota.checkedAt;
				account.blockedUntil = quota.resetAt ? quota.resetAt * 1000 : Date.now() + 60_000;
			} else {
				delete account.blockedUntil;
				delete account.blockedAt;
			}
		});
	}

	close(): void {
		this.database.close();
	}
}
