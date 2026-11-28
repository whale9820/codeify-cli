import type { AssistantMessage } from "../types.ts";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	// OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
	// Zen API. These are subscription/account limits, not transient throttles.
	"GoUsageLimitError",
	"FreeUsageLimitError",

	// OpenCode Go subscription-limit text asks users to enable available-balance
	// usage after rolling/weekly/monthly limits are reached.
	"Monthly usage limit reached",
	"available balance",

	// Generic quota/budget/billing exhaustion. `insufficient_quota` is OpenAI's
	// quota/billing error code; the other strings cover common gateway wording.
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",
]);

export const NETWORK_UNSTABLE_ERROR_MESSAGE = "network unstable please try again";
export const MAX_ASSISTANT_RETRIES = 2;
export const SAFEGUARD_BLOCK_MESSAGE = "Blocked by model safeguards";

export function isSafeguardBlock(errorMessage: string | undefined): boolean {
	return errorMessage?.startsWith(SAFEGUARD_BLOCK_MESSAGE) ?? false;
}

const MALFORMED_JSON_ERROR_PATTERN =
	/expected ':' after property name in json|expected ',' or '}' after property value in json|expected ',' or ']' after array element in json|unterminated string in json|unterminated string starting at|expected double-quoted property name in json|expecting property name enclosed in double quotes|expecting ',' delimiter|expecting ':' delimiter|expecting value: line|jsondecodeerror|illegal trailing comma|trailing comma before end|server_tool_stream_failed|upstream tool-call echo\s+contains invalid json arguments; no tools were emitted/i;
const JSON_EXTRA_DATA_ERROR_PATTERN = /\bjsondecodeerror:\s*extra data\b/i;

export function isMalformedJsonError(errorMessage: string): boolean {
	return MALFORMED_JSON_ERROR_PATTERN.test(errorMessage);
}

const HTTP_STATUS_PATTERN =
	/^(?:Error:\s*)?(?:(?:API Error\s*\(|HTTP(?: status)?\s+|Request failed with status code\s+))?([45]\d{2})(?=[\s:)]|$)/i;
const REQUEST_TIMED_OUT_PATTERN = /request timed out/i;
const NO_OUTPUT_WITHIN_30S_PATTERN = /no output within 30s/i;
// The gateway envelopes every upstream failure as `upstream_error: ...`; match only the
// listed transient transport errors so other upstream failures are not retried.
const UPSTREAM_ERROR_PATTERN = /upstream_error\s*:\s*(?:connection reset|timeout)\b/i;
const UPSTREAM_STREAM_READ_ERROR_PATTERN = /upstream stream failed:\s*(?:ReadError|RemoteProtocolError)\b/i;
const UPSTREAM_HTTP2_STREAM_ERROR_PATTERN = /upstream_http2_stream_error|upstream http\/2 stream failed/i;
const UPSTREAM_RESPONSE_INTERRUPTED_PATTERN = /upstream response stream was interrupted/i;
const INTERRUPTED_STREAM_PATTERN = /\bstream (?:was )?interrupted\b|\bRemoteProtocolError\b/i;
const UNEXPECTED_EOF_PATTERN = /unexpected\s*eof/i;

export function isReconnectableProviderError(errorMessage: string): boolean {
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	const status = Number(HTTP_STATUS_PATTERN.exec(errorMessage)?.[1]);
	if (status >= 400 && status < 500) return false;
	return (
		status >= 500 ||
		REQUEST_TIMED_OUT_PATTERN.test(errorMessage) ||
		NO_OUTPUT_WITHIN_30S_PATTERN.test(errorMessage) ||
		UPSTREAM_ERROR_PATTERN.test(errorMessage) ||
		UPSTREAM_STREAM_READ_ERROR_PATTERN.test(errorMessage) ||
		UPSTREAM_HTTP2_STREAM_ERROR_PATTERN.test(errorMessage) ||
		UPSTREAM_RESPONSE_INTERRUPTED_PATTERN.test(errorMessage) ||
		INTERRUPTED_STREAM_PATTERN.test(errorMessage) ||
		UNEXPECTED_EOF_PATTERN.test(errorMessage)
	);
}

export function resolveAssistantRetryLimit(errorMessage: string | undefined, configuredMaxRetries: number): number {
	const limit = JSON_EXTRA_DATA_ERROR_PATTERN.test(errorMessage ?? "") ? 1 : MAX_ASSISTANT_RETRIES;
	return configuredMaxRetries > 0 ? Math.min(Math.floor(configuredMaxRetries), limit) : 0;
}

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// Generic provider load, HTTP status, and server-side transient failures.
	"overloaded",
	"rate.?limit",
	"too many requests",
	"service.?unavailable",
	"server.?error",
	"\\binternal[_ -](?:server[_ -])?error\\b",
	"request could not be completed",
	"upstream_account_unavailable",
	"no upstream account is currently available",

	// Network, proxy, and fetch transport failures. This includes OpenAI Codex
	// raw-fetch failures such as "upstream connect", "connection refused", and
	// "reset before headers" (#733), plus OpenRouter connection drops (#3317).
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"\\b(?:request|connection|stream|socket|read|connect)[_ -]timeout\\b",
	"^(?:[\\w]*Error:\\s*)?terminated(?:\\b|$)",

	// WebSocket transports can report close/error text instead of HTTP/fetch text.
	"websocket.?closed",
	"websocket.?error",

	// Transport-level failure reading the response stream body. Providers/SDKs can
	// surface a partial read of an in-flight stream as "stream_read_error".
	"stream_read_error",
	"stream read error",

	// Premature stream endings from SDKs and transports. Anthropic can throw
	// "stream ended without ..." and "Anthropic stream ended before message_stop"
	// (#4433); Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",
	"stream disconnected",
	"stream closed before",
	"closed before response\\.completed",

	// Provider-requested retry delay cap failures should flow through the outer
	// retry policy so callers can surface/abort the backoff (#1123).
	"retry delay",

	// Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
	// stream exceptions (#6019).
	"you can retry your request",
	"try your request again",
	"please retry your request",

	// gRPC based providers (e.g. NVIDIA NIM)
	"ResourceExhausted",
]);

/**
 * Retry policy: bounded attempts with exponential backoff (`baseDelayMs * 2^(attempt-1)`).
 * Matches `settings.retry` (`enabled`, `maxRetries`, `baseDelayMs`) in coding-agent; kept
 * here so the classifier and the policy-driven retry loop live together and stay reusable
 * by the SDK and other callers.
 */
export interface RetryPolicy {
	enabled: boolean;
	/** Max retry attempts (0 = no retries). The initial call never counts as a retry. */
	maxRetries: number;
	/** Base delay in ms. Per-attempt delay is `baseDelayMs * 2^(attempt-1)` before jitter. */
	baseDelayMs: number;
}

/** Optional callbacks emitted by {@link retryAssistantCall} around each retry. */
export interface RetryCallbacks {
	/** Emitted before the backoff sleep of each retry attempt (1-indexed). */
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
	) => void | Promise<void>;
	/** Emitted after the backoff sleep, immediately before the retried call starts. */
	onRetryAttemptStart?: () => void | Promise<void>;
	/** Emitted once when the loop ends: success if a later call completed normally. */
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

class RetrySleepAbortError extends Error {
	constructor() {
		super("Aborted");
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new RetrySleepAbortError());
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new RetrySleepAbortError());
			},
			{ once: true },
		);
	});
}

/**
 * Run a single assistant-producing call with bounded retry on transient errors.
 *
 * Behavior:
 * - A successful response is returned immediately. Aborts are terminal and never
 *   retried, but reported as unsuccessful if they happen after a retry was scheduled.
 *   Aborts during the backoff sleep are normalized to an aborted `AssistantMessage`
 *   too, so callers do not need to care when cancellation happened.
 * - A non-retryable error (per {@link isRetryableAssistantError}, including quota/
 *   billing exhaustion) is returned immediately so deterministic errors fail fast.
 * - Otherwise retries up to `maxRetries` times (capped at two) with exponential backoff, emitting
 *   `onRetryScheduled` before each sleep, `onRetryAttemptStart` after each sleep before
 *   the retried call starts, and `onRetryFinished` once at the end (whether the loop
 *   ends in success, exhausted retries, or an aborted backoff).
 *
 * When `policy` is undefined or disabled, the first response is returned unchanged
 * (equivalent to calling `produce()` directly).
 */
export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const maxAttempts = policy?.enabled ? policy.maxRetries : 0;

	let attempt = 0;
	let lastRetry: { attempt: number; errorMessage: string } | undefined;
	for (;;) {
		const response = await produce();

		// Abort: terminal but not successful. Never retry an aborted message.
		if (response.stopReason === "aborted") {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
			return response;
		}

		// Success: non-error, non-abort responses return as-is.
		if (response.stopReason !== "error") {
			if (lastRetry) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
			return response;
		}

		// Non-retryable, or budget exhausted: return the final error message.
		const retryLimit = resolveAssistantRetryLimit(response.errorMessage, maxAttempts);
		if (attempt >= retryLimit || !isRetryableAssistantError(response)) {
			if (lastRetry && isMalformedJsonError(response.errorMessage ?? "")) {
				response.diagnostics = [
					...(response.diagnostics ?? []),
					{ type: "malformed_json", timestamp: Date.now(), error: { message: response.errorMessage! } },
				];
				response.errorMessage = NETWORK_UNSTABLE_ERROR_MESSAGE;
			}
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
			return response;
		}

		attempt++;
		lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };
		const delayMs = policy!.baseDelayMs * 2 ** (attempt - 1);
		await callbacks?.onRetryScheduled?.(attempt, retryLimit, delayMs, lastRetry.errorMessage);

		// Normalize aborts during retry backoff to the same AssistantMessage shape as
		// provider stream aborts, so callers do not need to care when cancellation happened.
		try {
			await sleep(delayMs, signal);
		} catch (error) {
			await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
			if (error instanceof RetrySleepAbortError) {
				return { ...response, stopReason: "aborted", errorMessage: undefined };
			}
			throw error;
		}
		await callbacks?.onRetryAttemptStart?.();
	}
}

/**
 * Classifies whether a failed assistant message looks like a transient provider
 * or transport error, so callers can decide if the last assistant turn should be
 * restarted.
 *
 * Strict allowlist: an error is retryable only when its text matches one of the
 * explicit patterns above. HTTP status codes never retry on their own. Client
 * errors (4xx) are never retried except for 408/429 whose body names a listed
 * transient condition (e.g. "rate limit", "too many requests"); providers also use
 * 429 for billing and account limits, which must fail fast.
 *
 * This does not implement retry policy. Callers should first handle context
 * overflow separately, then apply their own retry budget, backoff, and reporting
 * before restarting the assistant turn.
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage || isSafeguardBlock(message.errorMessage)) return false;
	const errorMessage = message.errorMessage;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	const status = Number(HTTP_STATUS_PATTERN.exec(errorMessage)?.[1]);
	if (status >= 400 && status < 500) {
		return (status === 408 || status === 429) && RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
	}
	return (
		isMalformedJsonError(errorMessage) ||
		isReconnectableProviderError(errorMessage) ||
		RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage)
	);
}
