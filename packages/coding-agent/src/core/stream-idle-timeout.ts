import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type StreamOptions,
} from "codeify-ai";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS } from "./http-dispatcher.ts";

export function streamWithIdleTimeout(
	model: Model<Api>,
	options: StreamOptions | undefined,
	start: (signal: AbortSignal) => Promise<AssistantMessageEventStream>,
): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	const controller = new AbortController();
	const timeoutMs = options?.timeoutMs ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let finished = false;
	let partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	const cleanup = () => {
		finished = true;
		clearTimeout(timer);
		options?.signal?.removeEventListener("abort", onAbort);
	};
	const fail = (reason: "error" | "aborted", errorMessage: string) => {
		if (finished) return;
		cleanup();
		const error: AssistantMessage = { ...structuredClone(partial), stopReason: reason, errorMessage };
		output.push({ type: "error", reason, error });
		output.end(error);
		controller.abort();
	};
	const onAbort = () => fail("aborted", "Request was aborted");
	const resetTimer = () => {
		clearTimeout(timer);
		if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
			timer = setTimeout(
				() => fail("error", `Request timed out: no streaming events for ${timeoutMs / 1000}s`),
				timeoutMs,
			);
		}
	};

	if (options?.signal?.aborted) {
		onAbort();
		return output;
	}
	options?.signal?.addEventListener("abort", onAbort, { once: true });
	resetTimer();
	void (async () => {
		try {
			const source = await start(controller.signal);
			if (finished) return;
			for await (const event of source) {
				if (finished) return;
				if (event.type === "done" || event.type === "error") {
					cleanup();
					output.push(event);
					output.end(event.type === "done" ? event.message : event.error);
					return;
				}
				partial = event.partial;
				output.push(event);
				resetTimer();
			}
			if (finished) return;
			const result = await source.result();
			if (finished) return;
			cleanup();
			output.end(result);
		} catch (error) {
			fail("error", error instanceof Error ? error.message : String(error));
		}
	})();
	return output;
}
