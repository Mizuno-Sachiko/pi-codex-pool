import type { Api, Model } from "@earendil-works/pi-ai";
import type { PoolConfig } from "./config.mts";
import { record } from "./limits.mts";

/** Read header names without executing dynamic configuration values a second time. */
export function configuredHeaderNames(model: Model<Api>, config: unknown): string[] {
	const provider = record(record(record(config)?.providers)?.[model.provider]);
	const definitions = provider?.models;
	const definition = Array.isArray(definitions)
		? record(definitions.find((entry) => record(entry)?.id === model.id))
		: undefined;
	const override = record(record(provider?.modelOverrides)?.[model.id]);
	return [
		...new Set(
			[
				...Object.keys(model.headers ?? {}),
				...Object.keys(record(provider?.headers) ?? {}),
				...Object.keys(record(definition?.headers) ?? {}),
				...Object.keys(record(override?.headers) ?? {}),
			].map((name) => name.toLowerCase()),
		),
	];
}

export function selectAccountModel<T extends { id: string }>(models: readonly T[], preferred?: string): T | undefined {
	return models.find((model) => model.id === preferred) ?? models[0];
}

export function buildPoolModels(
	pool: PoolConfig | undefined,
	modelsFor: (provider: string) => readonly Model<Api>[],
): Model<Api>[] {
	if (!pool) return [];
	const baseModels = new Map(modelsFor(pool.baseProvider).map((model) => [model.id, model]));
	const models = new Map<string, Model<Api>>();
	for (const member of pool.members) {
		for (const model of modelsFor(member)) {
			const name = baseModels.get(model.id)?.name ?? model.name;
			if (!models.has(model.id)) {
				const definition = structuredClone({ ...model, provider: pool.name, name: `${name} (${pool.name})` });
				// Transport headers belong to the selected account, not the first pool member.
				delete definition.headers;
				models.set(model.id, definition);
			}
		}
	}
	return [...models.values()];
}
