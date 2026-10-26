import {
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxProvider,
	isRetryableAssistantError,
	retryAssistantCall,
} from "codeify-ai";
import { streamSimple } from "codeify-ai/compat";
import { afterEach, describe, expect, test, vi } from "vitest";
import { streamWithIdleTimeout } from "../src/core/stream-idle-timeout.ts";
import { createHarness } from "./suite/harness.ts";

const model = fauxProvider().getModel();

describe("stream idle timeout", () => {
	afterEach(() => vi.useRealTimers());

	test("times out a silent stream and cancels its transport", async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		const output = streamWithIdleTimeout(model, { timeoutMs: 1000 }, async (requestSignal) => {
			signal = requestSignal;
			return createAssistantMessageEventStream();
		});
		await vi.advanceTimersByTimeAsync(1000);
		const result = await output.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Request timed out: no streaming events for 1s");
		expect(isRetryableAssistantError(result)).toBe(true);
		expect(signal?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("resets on chunks, preserves partial output, and ignores late events", async () => {
		vi.useFakeTimers();
		const source = createAssistantMessageEventStream();
		const partial = fauxAssistantMessage("partial");
		const output = streamWithIdleTimeout(model, { timeoutMs: 1000 }, async () => source);
		await vi.advanceTimersByTimeAsync(750);
		source.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial });
		await vi.advanceTimersByTimeAsync(750);
		let ended = false;
		void output.result().then(() => {
			ended = true;
		});
		await Promise.resolve();
		expect(ended).toBe(false);
		await vi.advanceTimersByTimeAsync(250);
		const result = await output.result();
		expect(result.content).toEqual(partial.content);
		partial.content = [{ type: "text", text: "late mutation" }];
		source.push({ type: "done", reason: "stop", message: partial });
		await vi.advanceTimersByTimeAsync(0);
		expect(result.content).toEqual([{ type: "text", text: "partial" }]);
		const events: AssistantMessageEvent[] = [];
		for await (const event of output) events.push(event);
		expect(events.map((event) => event.type)).toEqual(["text_delta", "error"]);
	});

	test("re-requests a stalled response through the bounded retry policy", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const response = retryAssistantCall(
			() =>
				streamWithIdleTimeout(model, { timeoutMs: 1000 }, async () => {
					calls++;
					const source = createAssistantMessageEventStream();
					if (calls === 2)
						source.push({ type: "done", reason: "stop", message: fauxAssistantMessage("recovered") });
					return source;
				}).result(),
			{ enabled: true, maxRetries: 1, baseDelayMs: 1 },
			undefined,
		);
		await vi.advanceTimersByTimeAsync(1001);
		expect((await response).content).toEqual([{ type: "text", text: "recovered" }]);
		expect(calls).toBe(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("honors cancellation even when the provider ignores abort", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const output = streamWithIdleTimeout(model, { timeoutMs: 1000, signal: controller.signal }, async () =>
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
		const output = streamWithIdleTimeout(model, { timeoutMs: 1000 }, async (requestSignal) => {
			signal = requestSignal;
			const source = createAssistantMessageEventStream();
			source.push({ type: "done", reason: "stop", message });
			return source;
		});
		expect(await output.result()).toBe(message);
		expect(signal?.aborted).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("times out pending setup", async () => {
		vi.useFakeTimers();
		const output = streamWithIdleTimeout(model, { timeoutMs: 1000 }, () => new Promise(() => {}));
		await vi.advanceTimersByTimeAsync(1000);
		expect((await output.result()).stopReason).toBe("error");
	});

	test("honors a disabled timeout", async () => {
		vi.useFakeTimers();
		const source = createAssistantMessageEventStream();
		const output = streamWithIdleTimeout(model, { timeoutMs: 0 }, async () => source);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(vi.getTimerCount()).toBe(0);
		source.push({ type: "done", reason: "stop", message: fauxAssistantMessage("done") });
		expect((await output.result()).stopReason).toBe("stop");
	});

	test.each([true, false])("session recovers from a stalled provider when retry is %s", async (enabled) => {
		const harness = await createHarness({
			settings: { retry: { enabled, maxRetries: 1, baseDelayMs: 0 } },
		});
		let calls = 0;
		const signals: AbortSignal[] = [];
		try {
			const model = harness.getModel();
			harness.setResponses([fauxAssistantMessage("recovered")]);
			harness.session.modelRuntime.registerProvider(model.provider, {
				api: model.api,
				streamSimple: (requestModel, context, options) => {
					calls++;
					if (options?.signal) signals.push(options.signal);
					if (calls > 1) return streamSimple(requestModel, context, options);
					const source = createAssistantMessageEventStream();
					source.push({ type: "start", partial: fauxAssistantMessage("frozen partial") });
					return source;
				},
			});
			harness.session.agent.streamFunction = (requestModel, context, options) =>
				harness.session.modelRuntime.streamSimple(requestModel, context, { ...options, timeoutMs: 20 });
			await harness.session.prompt("test stalled stream");
			expect(calls).toBe(enabled ? 2 : 1);
			expect(signals[0]?.aborted).toBe(true);
			expect(harness.eventsOfType("auto_retry_start")).toHaveLength(enabled ? 1 : 0);
			if (enabled) {
				expect(harness.session.messages.at(-1)).toMatchObject({
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "recovered" }],
				});
				expect(harness.session.messages).not.toEqual(
					expect.arrayContaining([expect.objectContaining({ stopReason: "error" })]),
				);
			}
		} finally {
			harness.cleanup();
		}
	});
});
