import { createHash, randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Model,
	AuthResult,
	ProviderHeaders,
	ProviderStreams,
	SimpleStreamOptions,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	appendAssistantMessageDiagnostic,
	createAssistantMessageEventStream,
	isRetryableAssistantError,
	registerSessionResourceCleanup,
} from "@earendil-works/pi-ai";
import { accountKey, classifyFailure, record } from "./limits.mts";
import { unavailableUntil, type Member, type RequestLease, type SharedPoolState } from "./shared-state.mts";

export interface RoutingPool {
	name: string;
	members: string[];
	enabled: boolean;
	strategy?: "round-robin" | "quota-first" | "scheduled" | "custom";
}

interface RoutingConfig {
	pools: RoutingPool[];
	chains: {
		enabled: boolean;
		entries: { pool: string; model: string; enabled: boolean }[];
	}[];
	maxRetries?: number;
	maxConcurrentPerAccount?: number;
}

export interface RoutingStatus {
	sessionId?: string;
	pool: string;
	provider?: string;
	status: "waiting" | "active";
}

interface RouterDependencies {
	warn?(message: string): void;
	state(): SharedPoolState;
	config(): RoutingConfig;
	member(provider: string): Member;
	hasAuth(provider: string): boolean;
	model(provider: string, id: string): Model<Api> | undefined;
	poolModel(pool: string, id: string): Model<Api> | undefined;
	headerNames(model: Model<Api>): string[];
	auth(model: Model<Api>, signal: AbortSignal): Promise<AuthResult | undefined>;
	order(
		pool: string,
		members: string[],
		model: string,
		previous: string | undefined,
		prompt: string | undefined,
		signal: AbortSignal,
	): Promise<{ members: string[]; ordered: boolean }>;
	checkLimits(signal: AbortSignal): Promise<unknown>;
	transport: ProviderStreams;
	connections: CodexConnections;
	status?(status: RoutingStatus): void;
}

/** Pi's socket cache identifies workspaces, so account changes must also check the user. */
export class CodexConnections {
	private users = new Map<string, string>();
	private queue = new Map<string, Promise<void>>();
	private unregisterCleanup?: () => void;

	private close: (sessionId: string) => void;

	constructor(close: (sessionId: string) => void) {
		this.close = close;
	}

	async acquire(sessionId: string, account: string, signal: AbortSignal): Promise<() => void> {
		signal.throwIfAborted();
		this.unregisterCleanup ??= registerSessionResourceCleanup((id) => {
			if (id === undefined) this.users.clear();
			else this.users.delete(id);
			if (!this.users.size && !this.queue.size) {
				this.unregisterCleanup?.();
				this.unregisterCleanup = undefined;
			}
		});
		const previous = this.queue.get(sessionId) ?? Promise.resolve();
		const reservation = Promise.withResolvers<void>();
		const tail = previous.then(() => reservation.promise);
		this.queue.set(sessionId, tail);
		const release = () => {
			reservation.resolve();
			void tail.then(() => {
				if (this.queue.get(sessionId) === tail) this.queue.delete(sessionId);
			});
		};
		const cancellation = Promise.withResolvers<never>();
		const onAbort = () => cancellation.reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			await Promise.race([previous, cancellation.promise]);
			signal.throwIfAborted();
			if (this.users.get(sessionId) !== account) this.close(sessionId);
			this.users.set(sessionId, account);
			return release;
		} catch (error) {
			release();
			throw error;
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}
}

/** The latest successful response after the latest user message owns tool continuations. */
export function previousResponse(context: TranscriptContext): AssistantMessage | undefined {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message.role === "user") return undefined;
		if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted")
			return message;
	}
	return undefined;
}

function errorMessage(model: Model<Api>, error: unknown, aborted: boolean): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: Date.now(),
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function poolFailure(
	message: AssistantMessage,
	pool: string,
	attempts: number,
	kind: string,
	partial: boolean,
): AssistantMessage {
	// Pi also retries by error text; keep pool retries in this request's budget.
	return {
		...message,
		diagnostics: [
			...(message.diagnostics ?? []),
			{
				type: "pool_request_failure",
				timestamp: Date.now(),
				error: { message: message.errorMessage ?? "Request failed" },
				details: { pool, provider: message.provider, attempts, kind },
			},
		],
		errorMessage: partial
			? "Pool response interrupted after partial output; retry manually."
			: `Pool stopped after ${attempts} account attempts (${kind}); check ${kind === "auth" ? "/subs login" : "/subs limits"}.`,
	};
}

function mergeHeaders(...sources: (ProviderHeaders | undefined)[]): ProviderHeaders {
	return Object.assign(
		{},
		...sources.map((source) =>
			Object.fromEntries(Object.entries(source ?? {}).map(([key, value]) => [key.toLowerCase(), value])),
		),
	);
}

interface RetryRoute {
	requestKey: string;
	pool: string;
	model: string;
	member: Member;
	dispose?(): void;
}

export class PoolRouter {
	private dependencies: RouterDependencies;
	private retries = new Map<string, RetryRoute>();
	private unregisterCleanup?: () => void;

	constructor(dependencies: RouterDependencies) {
		this.dependencies = dependencies;
	}

	private setRetry(sessionId: string | undefined, route?: RetryRoute): void {
		if (sessionId === undefined) {
			for (const retained of this.retries.values()) retained.dispose?.();
			this.retries.clear();
		} else {
			this.retries.get(sessionId)?.dispose?.();
			if (route) {
				this.retries.set(sessionId, route);
				this.unregisterCleanup ??= registerSessionResourceCleanup((id) => this.setRetry(id));
			} else {
				this.retries.delete(sessionId);
			}
		}
		if (!this.retries.size) {
			this.unregisterCleanup?.();
			this.unregisterCleanup = undefined;
		}
	}

	/** A virtual selection dispatches here; reservations only belong to the streaming request. */
	poolStreams(pool: string): ProviderStreams {
		return {
			stream: (model, context, options) => this.request({ ...model, provider: pool }, context, options, false),
			streamSimple: (model, context, options) => this.request({ ...model, provider: pool }, context, options, true),
		};
	}

	stream: ProviderStreams["stream"] = (model, context, options) => this.request(model, context, options, false);
	streamSimple: ProviderStreams["streamSimple"] = (model, context, options) =>
		this.request(model, context, options, true);

	private request(
		model: Model<Api>,
		context: TranscriptContext,
		options: SimpleStreamOptions | undefined,
		simple: boolean,
	) {
		const output = createAssistantMessageEventStream();
		void (async () => {
			const deps = this.dependencies;
			const controller = new AbortController();
			const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
			const requestId = randomUUID();
			const attempted = new Set<string>();
			let lease: RequestLease | undefined;
			let heartbeat: ReturnType<typeof setInterval> | undefined;
			let releaseConnection: (() => void) | undefined;
			let currentModel = model;
			let started: AssistantMessageEvent | undefined;
			let emitted = false;
			let partial: AssistantMessage | undefined;
			let refreshed = false;
			let attempts = 0;
			let lastError: AssistantMessage | undefined;
			let lastFailure = "auth";
			let waiting = false;
			let route: Omit<RetryRoute, "requestKey" | "dispose"> | undefined;
			let contextKey: string | undefined;
			// Pi omits failed attempts before retrying; retain only a digest of that request's context.
			const requestKey = () =>
				(contextKey ??= createHash("sha256")
					.update(
						JSON.stringify([
							model.provider,
							model.id,
							context.messages.filter(
								(message) =>
									message.role !== "assistant" || (message.stopReason !== "error" && message.stopReason !== "aborted"),
							),
						]),
					)
					.digest("hex"));
			const cleanupErrors: string[] = [];
			const invalid = new Set<string>();
			const memberFor = (provider: string): Member | undefined => {
				if (invalid.has(provider)) return undefined;
				try {
					return deps.member(provider);
				} catch {
					invalid.add(provider);
					deps.warn?.(`${provider}: invalid account credential; use /subs login`);
					return undefined;
				}
			};
			const release = () => {
				const connection = releaseConnection;
				const reservation = lease;
				const queued = waiting;
				releaseConnection = undefined;
				lease = undefined;
				waiting = false;
				if (heartbeat) clearInterval(heartbeat);
				heartbeat = undefined;
				// Detach ownership before cleanup so a failed release is never repeated.
				for (const operation of [
					() => connection?.(),
					() => {
						if (reservation) deps.state().release(reservation.id);
					},
					() => {
						if (queued) deps.state().cancelWait(requestId);
					},
				]) {
					try {
						operation();
					} catch (error) {
						cleanupErrors.push(error instanceof Error ? error.message : String(error));
					}
				}
			};
			const finish = (event: Extract<AssistantMessageEvent, { type: "done" | "error" }>) => {
				release();
				const message = event.type === "done" ? event.message : event.error;
				const sessionId = options?.sessionId;
				if (sessionId) {
					if (route && event.type === "error" && !signal.aborted && isRetryableAssistantError(message)) {
						const onAbort = () => this.setRetry(sessionId);
						signal.addEventListener("abort", onAbort, { once: true });
						this.setRetry(sessionId, {
							...route,
							requestKey: requestKey(),
							dispose: () => signal.removeEventListener("abort", onAbort),
						});
					} else {
						const retained = this.retries.get(sessionId);
						if (retained && retained.requestKey === requestKey()) this.setRetry(sessionId);
					}
				}
				if (cleanupErrors.length) {
					appendAssistantMessageDiagnostic(message, {
						type: "pool_cleanup_failure",
						timestamp: Date.now(),
						error: { message: cleanupErrors.join("; ") },
					});
					console.warn(`Pool cleanup failed: ${cleanupErrors.join("; ")}`);
				}
				output.push(event);
				output.end();
			};
			try {
				signal.throwIfAborted();
				const config = deps.config();
				const pool = config.pools.find((candidate) => candidate.name === model.provider && candidate.enabled);
				// A physical account is pinned even when it is also a member of a pool.
				const targets = pool
					? [{ pool, model: model.id }]
					: [
							{
								pool: {
									name: model.provider,
									members: [model.provider],
									enabled: true,
								},
								model: model.id,
							},
						];
				if (!pool && !deps.hasAuth(model.provider)) throw new Error(`No authenticated account for ${model.provider}`);
				const chain =
					pool &&
					config.chains.find(
						(candidate) =>
							candidate.enabled &&
							candidate.entries.some((entry) => entry.enabled && entry.pool === pool.name && entry.model === model.id),
					);
				if (chain && pool) {
					const position = chain.entries.findIndex(
						(entry) => entry.enabled && entry.pool === pool.name && entry.model === model.id,
					);
					for (const entry of chain.entries.slice(position + 1)) {
						const target = config.pools.find((candidate) => candidate.name === entry.pool && candidate.enabled);
						if (entry.enabled && target) targets.push({ pool: target, model: entry.model });
					}
				}
				const previous = previousResponse(context);
				const pending = options?.sessionId ? this.retries.get(options.sessionId) : undefined;
				let retained = pending && pending.requestKey === requestKey() ? pending : undefined;
				if (pending && !retained && options?.sessionId) this.setRetry(options.sessionId);
				const user = context.messages.findLast((message) => message.role === "user");
				const prompt =
					typeof user?.content === "string"
						? user.content
						: user?.content
								.filter((content) => content.type === "text")
								.map((content) => content.text)
								.join("\n");
				if (pool && (retained || previous)) {
					const previousPool = previous?.diagnostics?.findLast(
						(entry) => entry.type === "pool_route" && entry.details?.source === pool.name,
					)?.details?.pool;
					const position = targets.findIndex((target) =>
						retained
							? target.pool.name === retained.pool && target.model === retained.model
							: target.model === previous?.model &&
								target.pool.members.includes(previous.provider) &&
								(!previousPool || target.pool.name === previousPool),
					);
					if (position > 0) targets.splice(0, position);
					if (position < 0) retained = undefined;
				}
				const scopedHeaders = new Set(pool ? deps.headerNames(model) : []);
				// Configured source fields belong to that pool, even if a caller supplied the same name.
				const callerHeaders = Object.fromEntries(
					Object.entries(mergeHeaders(options?.headers)).filter(([name]) => !scopedHeaders.has(name)),
				);
				const budget = pool ? (config.maxRetries ?? 3) + 1 : 1;
				for (const target of targets) {
					const targetModel =
						!pool || (target.pool.name === model.provider && target.model === model.id)
							? model
							: deps.poolModel(target.pool.name, target.model);
					if (!targetModel) continue;
					const sourceTarget = target.pool.name === model.provider && target.model === model.id;
					// Pi already resolved the source request, including any !command header values.
					const targetAuth = pool && !sourceTarget ? await deps.auth(targetModel, signal) : undefined;
					while (attempts < budget) {
						signal.throwIfAborted();
						const live = deps.config();
						const livePool = pool
							? live.pools.find((candidate) => candidate.name === target.pool.name && candidate.enabled)
							: target.pool;
						if (!livePool) break;
						let providers = livePool.members.filter(
							(provider) => deps.hasAuth(provider) && deps.model(provider, target.model) && !invalid.has(provider),
						);
						if (providers.length === 0) break;
						providers = providers.filter((provider) => {
							const member = memberFor(provider);
							return member && !attempted.has(member.key);
						});
						const ordering = await deps.order(
							livePool.name,
							providers,
							target.model,
							previous?.provider,
							prompt,
							signal,
						);
						providers = ordering.members;
						if (providers.length === 0) break;
						const state = deps.state();
						const now = Date.now();
						let members = providers.map(memberFor).filter((member): member is Member => member !== undefined);
						if (!members.length) break;
						const snapshot = state.snapshot();
						const sticky =
							attempts === 0 &&
							members.find((member) => {
								const matches = retained
									? target.pool.name === retained.pool &&
										target.model === retained.model &&
										member.provider === retained.member.provider &&
										member.key === retained.member.key
									: previous?.model === target.model && member.provider === previous.provider;
								return matches && unavailableUntil(snapshot.accounts[member.key], now) <= now;
							});
						if (sticky) members = [sticky];
						const ordered = Boolean(sticky) || ordering.ordered;
						lease = state.reserve(
							members,
							live.maxConcurrentPerAccount ?? 2,
							pool && !sticky && !ordered ? livePool.name : undefined,
							requestId,
							ordered,
						);
						waiting = !lease;
						if (!lease) {
							const current = state.snapshot();
							if (members.every((member) => unavailableUntil(current.accounts[member.key], now) > now)) {
								release();
								break;
							}
							deps.status?.({
								sessionId: options?.sessionId,
								pool: livePool.name,
								status: "waiting",
							});
							await wait(250, undefined, { signal });
							continue;
						}
						const reservation = lease;
						attempted.add(reservation.key);
						attempts++;
						heartbeat = setInterval(() => {
							try {
								state.renew(reservation.id);
							} catch (error) {
								controller.abort(error);
							}
						}, 30_000);
						heartbeat.unref();
						const selected = deps.model(reservation.provider, target.model);
						if (!selected) throw new Error(`Model ${reservation.provider}/${target.model} was removed`);
						currentModel = {
							...targetModel,
							provider: selected.provider,
							api: selected.api,
							baseUrl: targetAuth?.auth.baseUrl ?? selected.baseUrl,
							headers: undefined,
						};
						const resolved =
							!pool && options?.apiKey
								? { auth: { apiKey: options.apiKey, headers: options.headers }, env: options.env }
								: await deps.auth(selected, signal).catch((error: unknown) => {
										signal.throwIfAborted();
										lastError = errorMessage(currentModel, error, false);
										return undefined;
									});
						const auth = resolved?.auth;
						if (!auth?.apiKey) {
							state.fail(reservation.key, "Authentication unavailable; use /subs login", Date.now() + 30_000);
							lastError ??= errorMessage(currentModel, "Authentication unavailable; use /subs login", false);
							release();
							continue;
						}
						let authenticatedKey: string;
						try {
							authenticatedKey = accountKey(reservation.provider, auth.apiKey);
						} catch {
							const message = "Invalid refreshed credential; use /subs login";
							lastError = errorMessage(currentModel, message, false);
							state.fail(reservation.key, message, Date.now() + 30_000);
							release();
							continue;
						}
						// Refresh must not change the identity whose shared slot was reserved.
						if (authenticatedKey !== reservation.key) {
							lastError = errorMessage(currentModel, "Account identity changed while preparing the request", false);
							release();
							continue;
						}
						if (options?.sessionId && options.transport !== "sse") {
							releaseConnection = await deps.connections.acquire(options.sessionId, reservation.key, signal);
						}
						deps.status?.({
							sessionId: options?.sessionId,
							pool: livePool.name,
							provider: reservation.provider,
							status: "active",
						});
						currentModel.baseUrl = targetAuth?.auth.baseUrl ?? auth.baseUrl ?? currentModel.baseUrl;
						const headersForRequest = sourceTarget
							? mergeHeaders(auth.headers, options?.headers)
							: mergeHeaders(auth.headers, targetAuth?.auth.headers, callerHeaders);
						let raw: unknown;
						let status: number | undefined;
						let headers: Record<string, string> = {};
						const requestOptions: SimpleStreamOptions = {
							...options,
							...auth,
							signal,
							maxRetries: 0,
							headers: headersForRequest,
							env: { ...resolved?.env, ...targetAuth?.env, ...options?.env },
							fetch: async (...args) => {
								const response = await (options?.fetch ?? globalThis.fetch)(...args);
								if (!response.ok) {
									try {
										raw = await response.clone().json();
									} catch {
										raw = undefined;
									}
								}
								return response;
							},
							onResponse: async (response, selected) => {
								status = response.status;
								headers = response.headers;
								await options?.onResponse?.(response, selected);
							},
							onProviderStreamEvent: async (event, selected) => {
								const value = record(event);
								if (value?.type === "error" || value?.type === "response.failed") raw = event;
								await options?.onProviderStreamEvent?.(event, selected);
							},
						};
						const startedAt = Date.now();
						if (pool)
							route = {
								pool: livePool.name,
								model: target.model,
								member: { provider: reservation.provider, key: reservation.key },
							};
						const transport = (simple ? deps.transport.streamSimple : deps.transport.stream)(
							currentModel,
							context,
							requestOptions,
						);
						let retry = false;
						for await (const event of transport) {
							if ("partial" in event) partial = event.partial;
							if (event.type === "start") {
								started = event;
								continue;
							}
							if (event.type === "done") {
								if (pool)
									appendAssistantMessageDiagnostic(event.message, {
										type: "pool_route",
										timestamp: Date.now(),
										details: { source: pool.name, pool: livePool.name },
									});
								state.succeed(reservation.key, startedAt);
								release();
							} else if (event.type === "error") {
								lastError = event.error;
								const failure = classifyFailure(event.error.errorMessage ?? "", raw, status, headers);
								lastFailure = failure.kind;
								if (event.reason !== "aborted" && failure.kind === "overload") {
									// Service-wide failures use Pi's visible backoff without penalizing this account.
									event.error.errorMessage = `Service temporarily unavailable: ${failure.message}`;
								}
								const accountFailure = failure.kind === "quota" || failure.kind === "rate" || failure.kind === "auth";
								if (event.reason !== "aborted" && accountFailure) {
									const time = Date.now();
									state.fail(
										reservation.key,
										failure.message.slice(0, 1000),
										failure.requestRetryAt ?? time + 30_000,
										failure.kind === "quota" ? failure.retryAt : undefined,
									);
									if (!refreshed && (failure.kind === "quota" || failure.kind === "rate")) {
										refreshed = true;
										release();
										await deps.checkLimits(signal);
									}
									retry = Boolean(pool) && !emitted && attempts < budget;
								}
								if (retry) {
									started = undefined;
									break;
								}
								if (pool && event.reason !== "aborted" && accountFailure) {
									event.error = poolFailure(event.error, pool.name, attempts, failure.kind, emitted);
								}
							}
							if (started) {
								output.push(started);
								started = undefined;
							}
							// A terminal event resolves result() immediately, before iterator cleanup.
							if (event.type === "done" || event.type === "error") {
								finish(event);
								return;
							}
							output.push(event);
							emitted = true;
						}
						release();
						if (!retry) throw new Error("Codex stream ended without a terminal result");
					}
				}
				release();
				if (lastError) {
					finish({
						type: "error",
						reason: "error",
						error: pool ? poolFailure(lastError, pool.name, attempts, lastFailure, false) : lastError,
					});
				} else {
					const candidates = targets
						.flatMap((target) => target.pool.members)
						.filter(deps.hasAuth)
						.map(memberFor)
						.filter((member): member is Member => member !== undefined);
					const state = deps.state().snapshot();
					const earliest = candidates.length
						? Math.min(...candidates.map((member) => unavailableUntil(state.accounts[member.key])))
						: undefined;
					throw new Error(
						earliest && earliest > Date.now()
							? `Pool ${model.provider} is cooling down until ${new Date(earliest).toISOString()}; use /subs limits to refresh`
							: `Pool ${model.provider} has no eligible member for ${model.id}`,
					);
				}
			} catch (error) {
				release();
				const failure = errorMessage(currentModel, error, signal.aborted);
				const message =
					emitted && partial
						? {
								...partial,
								stopReason: failure.stopReason,
								errorMessage: failure.errorMessage,
							}
						: failure;
				finish({
					type: "error",
					reason: signal.aborted ? "aborted" : "error",
					error: message,
				});
			}
		})();
		return output;
	}
}
