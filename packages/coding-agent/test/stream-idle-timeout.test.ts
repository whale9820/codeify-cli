import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider } from "codeify-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { streamWithIdleTimeout } from "../src/core/stream-idle-timeout.ts";

const model = fauxProvider().getModel();

describe("stream idle timeout", () => {
	afterEach(() => vi.useRealTimers());

	test("continues after a long pause between chunks", async () => {
		vi.useFakeTimers();
		const source = createAssistantMessageEventStream();
		let signal: AbortSignal | undefined;
		const output = streamWithIdleTimeout(model, { timeoutMs: 300_000 }, async (requestSignal) => {
			signal = requestSignal;
			return source;
		});
		source.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: fauxAssistantMessage("partial") });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(signal?.aborted).toBe(false);
		const message = fauxAssistantMessage("completed");
		source.push({ type: "done", reason: "stop", message });
		expect(await output.result()).toBe(message);
	});

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
		expect(vi.getTimerCount()).toBe(0);
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
