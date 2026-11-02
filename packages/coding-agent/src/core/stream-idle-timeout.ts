import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type StreamOptions,
} from "codeify-ai";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS } from "./http-dispatcher.ts";

const COMPLETION_IDLE_MS = 15_000;

export function streamWithIdleTimeout(
	model: Model<Api>,
	options: StreamOptions | undefined,
	start: (signal: AbortSignal) => Promise<AssistantMessageEventStream>,
): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	const controller = new AbortController();
	const timeoutMs = options?.timeoutMs ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let completionTimer: ReturnType<typeof setTimeout> | undefined;
	let source: AssistantMessageEventStream | undefined;
	const toolJson = new Map<number, string>();
	const endedTools = new Set<number>();
	const pendingServerTools = new Set<string>();
	const openThinking = new Set<number>();
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
		clearTimeout(completionTimer);
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
	const recoverCompletion = (): boolean => {
		if (finished || openThinking.size > 0 || pendingServerTools.size > 0) return false;
		if (partial.stopReason === "error" || partial.stopReason === "aborted") return false;
		const message = structuredClone(partial);
		let hasOutput = false;
		let hasTools = false;
		for (const [index, block] of message.content.entries()) {
			if (block.type === "text" && block.text.trim()) hasOutput = true;
			if (block.type === "toolCall") {
				if (!block.id || !block.name || message.stopReason === "length") return false;
				const raw = toolJson.get(index);
				if (raw) {
					try {
						const args: unknown = JSON.parse(raw);
						if (!args || typeof args !== "object" || Array.isArray(args)) return false;
						block.arguments = args as Record<string, unknown>;
					} catch {
						return false;
					}
				} else if (!endedTools.has(index)) {
					return false;
				}
				hasTools = true;
			}
			// Provider scratch fields must not leak into replay or persisted history.
			const scratch = block as typeof block & {
				index?: number;
				partialJson?: string;
				partialArgs?: string;
				streamIndex?: number;
			};
			delete scratch.index;
			delete scratch.partialJson;
			delete scratch.partialArgs;
			delete scratch.streamIndex;
		}
		if (!hasOutput && !hasTools) return false;
		message.stopReason = hasTools ? "toolUse" : message.stopReason === "length" ? "length" : "stop";
		delete message.errorMessage;
		cleanup();
		output.push({ type: "done", reason: message.stopReason, message });
		output.end(message);
		// Freeze the successful result before aborting the transport, which may mutate its partial.
		source?.end(message);
		controller.abort();
		return true;
	};
	const onAbort = () => fail("aborted", "Request was aborted");
	const resetTimer = () => {
		clearTimeout(timer);
		clearTimeout(completionTimer);
		completionTimer = setTimeout(recoverCompletion, COMPLETION_IDLE_MS);
		if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
			timer = setTimeout(
				() => {
					if (!recoverCompletion())
						fail("error", `Request timed out: no streaming chunks for ${timeoutMs / 1000}s`);
				},
				Math.min(timeoutMs, 2_147_483_647),
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
			source = await start(controller.signal);
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
				// Chat Completions may only close its reasoning block at transport EOF.
				if (event.type === "text_delta" || event.type === "toolcall_start") openThinking.clear();
				if (event.type === "toolcall_start") {
					toolJson.delete(event.contentIndex);
					endedTools.delete(event.contentIndex);
				} else if (event.type === "toolcall_delta") {
					toolJson.set(event.contentIndex, (toolJson.get(event.contentIndex) ?? "") + event.delta);
				} else if (event.type === "toolcall_end") {
					endedTools.add(event.contentIndex);
				} else if (event.type === "thinking_start") {
					openThinking.add(event.contentIndex);
				} else if (event.type === "thinking_end") {
					openThinking.delete(event.contentIndex);
				} else if (event.type === "server_tool_use_start") {
					pendingServerTools.add(event.serverToolUse.id);
				} else if (event.type === "server_tool_result_end") {
					pendingServerTools.delete(event.serverToolResult.toolUseId);
				}
				output.push(event);
				if (event.type !== "start" && (!("delta" in event) || event.delta.length > 0)) resetTimer();
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
