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

	test.each([undefined, 300_000, 0])(
		"recovers after 15 seconds with zero chunks when HTTP timeout is %s",
		async (timeoutMs) => {
			vi.useFakeTimers();
			let signal: AbortSignal | undefined;
			const output = streamWithIdleTimeout(model, { timeoutMs }, async (requestSignal) => {
				signal = requestSignal;
				return createAssistantMessageEventStream();
			});
			await vi.advanceTimersByTimeAsync(14_999);
			expect(signal?.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			const result = await output.result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("Request timed out: no streaming chunks for 15s");
			expect(isRetryableAssistantError(result)).toBe(true);
			expect(signal?.aborted).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	test("resets on chunks, preserves partial output, and ignores late events", async () => {
		vi.useFakeTimers();
		const source = createAssistantMessageEventStream();
		const partial = fauxAssistantMessage("partial");
		const output = streamWithIdleTimeout(model, { timeoutMs: 300_000 }, async () => source);
		await vi.advanceTimersByTimeAsync(12_000);
		source.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial });
		await vi.advanceTimersByTimeAsync(12_000);
		let ended = false;
		void output.result().then(() => {
			ended = true;
		});
		await Promise.resolve();
		expect(ended).toBe(false);
		await vi.advanceTimersByTimeAsync(3_000);
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
				streamWithIdleTimeout(model, { timeoutMs: 300_000 }, async () => {
					calls++;
					const source = createAssistantMessageEventStream();
					if (calls === 2)
						source.push({ type: "done", reason: "stop", message: fauxAssistantMessage("recovered") });
					return source;
				}).result(),
			{ enabled: true, maxRetries: 1, baseDelayMs: 1 },
			undefined,
		);
		await vi.advanceTimersByTimeAsync(15_001);
		expect((await response).content).toEqual([{ type: "text", text: "recovered" }]);
		expect(calls).toBe(2);
		expect(vi.getTimerCount()).toBe(0);
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

	test("times out pending setup", async () => {
		vi.useFakeTimers();
		const output = streamWithIdleTimeout(model, { timeoutMs: 300_000 }, () => new Promise(() => {}));
		await vi.advanceTimersByTimeAsync(15_000);
		expect((await output.result()).stopReason).toBe("error");
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

	test.each([true, false])("session recovers from a stalled provider when retry is %s", async (enabled) => {
		const harness = await createHarness({
			settings: { retry: { enabled, maxRetries: 1, baseDelayMs: 0 } },
		});
		let calls = 0;
		const signals: AbortSignal[] = [];
		vi.useFakeTimers();
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
				harness.session.modelRuntime.streamSimple(requestModel, context, { ...options, timeoutMs: 300_000 });
			const response = harness.session.prompt("test stalled stream");
			await vi.advanceTimersByTimeAsync(15_001);
			await response;
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
