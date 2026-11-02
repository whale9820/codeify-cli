import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider } from "codeify-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { streamWithIdleTimeout } from "../src/core/stream-idle-timeout.ts";

const model = fauxProvider().getModel();

describe("stream idle timeout", () => {
	afterEach(() => vi.useRealTimers());

	test("continues after a long pause during reasoning", async () => {
		vi.useFakeTimers();
		const source = createAssistantMessageEventStream();
		let signal: AbortSignal | undefined;
		const output = streamWithIdleTimeout(model, { timeoutMs: 300_000 }, async (requestSignal) => {
			signal = requestSignal;
			return source;
		});
		source.push({
			type: "thinking_delta",
			contentIndex: 0,
			delta: "thinking",
			partial: fauxAssistantMessage([{ type: "thinking", thinking: "thinking" }]),
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(signal?.aborted).toBe(false);
		const message = fauxAssistantMessage("completed");
		source.push({ type: "done", reason: "stop", message });
		expect(await output.result()).toBe(message);
	});

	test("times out while waiting for the provider to open a stream", async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		const output = streamWithIdleTimeout(model, { timeoutMs: 1000 }, (requestSignal) => {
			signal = requestSignal;
			return new Promise(() => {});
		});
		await vi.advanceTimersByTimeAsync(1000);
		const result = await output.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("no streaming chunks for 1s");
		expect(signal?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("finalizes text without discarding it when the completion event never arrives", async () => {
		vi.useFakeTimers();
		const source = createAssistantMessageEventStream();
		let signal: AbortSignal | undefined;
		const output = streamWithIdleTimeout(model, { timeoutMs: 1000 }, async (requestSignal) => {
			signal = requestSignal;
			return source;
		});
		source.push({ type: "start", partial: fauxAssistantMessage("") });
		source.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: fauxAssistantMessage("partial") });
		await vi.advanceTimersByTimeAsync(999);
		expect(signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		const result = await output.result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "partial" }]);
		expect(result.errorMessage).toBeUndefined();
		expect(signal?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("recovers after 15 seconds, ignores empty deltas, and isolates late mutations", async () => {
		vi.useFakeTimers();
		const source = createAssistantMessageEventStream();
		const partial = fauxAssistantMessage("finished answer");
		const output = streamWithIdleTimeout(model, { timeoutMs: 300_000 }, async () => source);
		source.push({ type: "text_delta", contentIndex: 0, delta: "finished answer", partial });
		await vi.advanceTimersByTimeAsync(10_000);
		source.push({ type: "text_delta", contentIndex: 0, delta: "", partial });
		await vi.advanceTimersByTimeAsync(5_000);
		const result = await output.result();
		partial.stopReason = "aborted";
		partial.content = [];
		source.push({ type: "error", reason: "aborted", error: partial });
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "finished answer" }]);
		const events = [];
		for await (const event of output) events.push(event.type);
		expect(events).toEqual(["text_delta", "text_delta", "done"]);
		expect(vi.getTimerCount()).toBe(0);
	});

	test.each([true, false])("recovers a complete tool call with end event=%s", async (withEnd) => {
		vi.useFakeTimers();
		const source = createAssistantMessageEventStream();
		const tool = {
			type: "toolCall" as const,
			id: "call_1",
			name: "bash",
			arguments: { command: "printf ok" },
			partialArgs: "scratch",
		};
		const partial = fauxAssistantMessage([tool]);
		const output = streamWithIdleTimeout(model, { timeoutMs: 1000 }, async () => source);
		source.push({ type: "toolcall_start", contentIndex: 0, partial });
		source.push({ type: "toolcall_delta", contentIndex: 0, delta: '{"command":"printf ', partial });
		source.push({ type: "toolcall_delta", contentIndex: 0, delta: 'ok"}', partial });
		if (withEnd) source.push({ type: "toolcall_end", contentIndex: 0, toolCall: tool, partial });
		await vi.advanceTimersByTimeAsync(1000);
		const result = await output.result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "printf ok" } },
		]);
	});

	test.each(['{"command":"printf ok"', '{"command":"printf ok"}{}', "[]", "null"])(
		"does not execute incomplete or invalid tool JSON: %s",
		async (raw) => {
			vi.useFakeTimers();
			const source = createAssistantMessageEventStream();
			const tool = { type: "toolCall" as const, id: "call_1", name: "bash", arguments: { command: "printf ok" } };
			const partial = fauxAssistantMessage([tool]);
			const output = streamWithIdleTimeout(model, { timeoutMs: 1000 }, async () => source);
			source.push({ type: "toolcall_delta", contentIndex: 0, delta: raw, partial });
			source.push({ type: "toolcall_end", contentIndex: 0, toolCall: tool, partial });
			await vi.advanceTimersByTimeAsync(1000);
			expect((await output.result()).stopReason).toBe("error");
		},
	);

	test("honors cancellation even when the provider ignores abort", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const output = streamWithIdleTimeout(model, { timeoutMs: 300_000, signal: controller.signal }, async () =>
			createAssistantMessageEventStream(),
		);
		controller.abort();
		expect((await output.result()).stopReason).toBe("aborted");
		expect(vi.getTimerCount()).toBe(0);
	});

	test("does not start a provider for an already cancelled request", async () => {
		const start = vi.fn(async () => createAssistantMessageEventStream());
		const output = streamWithIdleTimeout(model, { signal: AbortSignal.abort() }, start);
		expect((await output.result()).stopReason).toBe("aborted");
		expect(start).not.toHaveBeenCalled();
	});

	test("cleans up after success without aborting the completed transport", async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		const message = fauxAssistantMessage("done");
		const output = streamWithIdleTimeout(model, { timeoutMs: 300_000 }, async (requestSignal) => {
			signal = requestSignal;
			const source = createAssistantMessageEventStream();
			source.push({ type: "done", reason: "stop", message });
			return source;
		});
		expect(await output.result()).toBe(message);
		expect(signal?.aborted).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("waits for pending setup until cancelled", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const output = streamWithIdleTimeout(
			model,
			{ timeoutMs: 300_000, signal: controller.signal },
			() => new Promise(() => {}),
		);
		let ended = false;
		void output.result().then(() => {
			ended = true;
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(ended).toBe(false);
		expect(vi.getTimerCount()).toBe(1);
		controller.abort();
		expect((await output.result()).stopReason).toBe("aborted");
	});

	test("keeps streaming beyond 15 seconds while chunks keep arriving", async () => {
		vi.useFakeTimers();
		const source = createAssistantMessageEventStream();
		const output = streamWithIdleTimeout(model, { timeoutMs: 0 }, async () => source);
		for (let chunk = 0; chunk < 3; chunk++) {
			await vi.advanceTimersByTimeAsync(14_000);
			source.push({
				type: "thinking_delta",
				contentIndex: 0,
				delta: "thinking",
				partial: fauxAssistantMessage("thinking"),
			});
			await vi.advanceTimersByTimeAsync(0);
		}
		source.push({ type: "done", reason: "stop", message: fauxAssistantMessage("done") });
		expect((await output.result()).stopReason).toBe("stop");
		expect(vi.getTimerCount()).toBe(0);
	});
});
