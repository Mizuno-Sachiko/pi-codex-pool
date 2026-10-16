import { createHash } from "node:crypto";

export interface LimitFailure {
	kind: "quota" | "rate" | "overload" | "auth" | "other";
	message: string;
	code?: string;
	retryAt?: number;
	/** Retry headers impose a request wait; quota resets and prose estimates can be revised by a quota check. */
	requestRetryAt?: number;
}

export function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function accountKey(provider: string, token?: string): string {
	if (!token) return provider;
	const encoded = token.split(".")[1];
	if (!encoded) throw new Error(`Invalid account credential for ${provider}`);
	const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
	const auth = record(payload["https://api.openai.com/auth"]);
	if (typeof payload.sub !== "string" || typeof auth?.chatgpt_account_id !== "string") {
		throw new Error(`Missing account identity for ${provider}`);
	}
	// Workspace members have distinct quotas; token refreshes retain this identity.
	return createHash("sha256").update(`${payload.sub}\0${auth.chatgpt_account_id}`).digest("hex");
}

export function retryAtFromText(message: string, now = Date.now()): number | undefined {
	const minutes = /try again in\s*~?\s*(\d+(?:\.\d+)?)\s*min/i.exec(message);
	if (minutes) return now + Number(minutes[1]) * 60_000;
	const seconds = /retry[- ]?after\D{0,10}(\d+(?:\.\d+)?)/i.exec(message);
	return seconds ? now + Number(seconds[1]) * 1000 : undefined;
}

export function classifyFailure(
	message: string,
	raw?: unknown,
	status?: number,
	headers: Record<string, string> = {},
	now = Date.now(),
): LimitFailure {
	const value = record(raw);
	const error = record(value?.error) ?? record(record(value?.response)?.error) ?? value;
	const code =
		typeof error?.code === "string"
			? error.code
			: typeof error?.type === "string" && error.type !== "error"
				? error.type
				: undefined;
	const original = typeof error?.message === "string" ? error.message : message;
	const reset = typeof error?.resets_at === "number" ? error.resets_at * 1000 : undefined;
	const retryAfter = headers["retry-after"];
	const delay =
		retryAfter === undefined
			? undefined
			: Number.isFinite(Number(retryAfter))
				? now + Number(retryAfter) * 1000
				: Date.parse(retryAfter);
	const retryMs = Number(headers["retry-after-ms"]);
	const requestRetryAt =
		(Number.isFinite(retryMs) && retryMs >= 0 ? now + retryMs : undefined) ??
		(Number.isFinite(delay) ? delay : undefined);
	const retryAt = reset ?? requestRetryAt ?? retryAtFromText(original, now);
	let kind: LimitFailure["kind"] = "other";
	if (status === 401 || code === "invalid_api_key" || code === "token_expired") kind = "auth";
	else if (code === "usage_limit_reached" || code === "insufficient_quota") kind = "quota";
	else if (code === "rate_limit_exceeded" || code === "too_many_requests") kind = "rate";
	else if (code === "context_length_exceeded" || code === "context_window_exceeded") kind = "other";
	else if (
		(status !== undefined && status >= 500 && status <= 599) ||
		(!code && status === undefined && /overloaded|at capacity|\bHTTP\s+5\d{2}\b/i.test(original))
	)
		kind = "overload";
	else if (
		!code &&
		(status === undefined || status === 429) &&
		/usage.?limit|quota.*(?:exceed|exhaust)|limit.*reached/i.test(original)
	)
		kind = "quota";
	else if (
		status === 429 ||
		(!code &&
			status === undefined &&
			/rate[\s_-]?limit|too many requests|(?:HTTP|status)\s*429\b|\b429\s+(?:rate|requests?)/i.test(original))
	)
		kind = "rate";
	return { kind, message: original, code, retryAt, requestRetryAt };
}
