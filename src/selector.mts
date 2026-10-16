import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { PoolConfig } from "./config.mts";
import { getDayOfWeek } from "./schedule.mts";

export interface PoolSelectorContext {
	members: string[];
	currentProvider: string;
	modelId: string;
	pool: { name: string; baseProvider: string; members: string[] };
	timestamp: number;
	hour: number;
	day: ReturnType<typeof getDayOfWeek>;
	prompt?: string;
	signal: AbortSignal;
}

/** Await cancellation even when a selector's asynchronous work never settles. */
export async function selectCustomMember(
	path: string,
	pool: PoolConfig,
	members: string[],
	modelId: string,
	signal: AbortSignal,
	currentProvider = "",
	prompt?: string,
): Promise<string[] | undefined> {
	signal.throwIfAborted();
	const cancelled = Promise.withResolvers<never>();
	const onAbort = () => cancelled.reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		const selection = (async () => {
			// File URLs work on Windows; a changed file receives a new module identity.
			const url = pathToFileURL(path);
			url.searchParams.set("mtime", String(statSync(path).mtimeMs));
			const module = await import(url.href);
			if (typeof module.default !== "function") throw new Error("Selector must export a default function");
			signal.throwIfAborted();
			const now = new Date();
			const context: PoolSelectorContext = {
				members: [...members],
				currentProvider,
				modelId,
				pool: { name: pool.name, baseProvider: pool.baseProvider, members: [...pool.members] },
				timestamp: now.getTime(),
				hour: now.getHours(),
				day: getDayOfWeek(now),
				prompt,
				signal,
			};
			const result: unknown = await module.default(context);
			if (result === undefined) return undefined;
			const choices = Array.isArray(result) ? result : [result];
			const selected = [
				...new Set(choices.filter((value): value is string => typeof value === "string" && members.includes(value))),
			];
			if (selected.length === 0) throw new Error("Selector returned no eligible account");
			return [...selected, ...members.filter((member) => !selected.includes(member))];
		})();
		return await Promise.race([selection, cancelled.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
