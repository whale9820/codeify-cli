import { type Context, fauxAssistantMessage, fauxThinking, fauxToolCall } from "codeify-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import * as outputGuard from "../../src/core/output-guard.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";
import { createHarness, getAssistantTexts, getMessageText, getUserTexts, type Harness } from "./harness.ts";

describe("output token limit continuation", () => {
	let harness: Harness;
	const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }));

	beforeEach(async () => {
		execute.mockClear();
		harness = await createHarness({
			tools: [{ name: "write", label: "Write", description: "Test tool", parameters: Type.Object({}), execute }],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		harness.cleanup();
	});

	it("retains every partial response in the next request, events, and persisted history", async () => {
		const requests: Context[] = [];
		harness.setResponses([
			fauxAssistantMessage("First part", { stopReason: "length" }),
			(context) => {
				requests.push({ ...context, messages: structuredClone(context.messages) });
				return fauxAssistantMessage("Second part", { stopReason: "length" });
			},
			(context) => {
				requests.push({ ...context, messages: structuredClone(context.messages) });
				return fauxAssistantMessage("Final part");
			},
		]);

		await harness.session.prompt("Write a long answer");

		expect(harness.faux.state.callCount).toBe(3);
		expect(getAssistantTexts(harness)).toEqual(["First part", "Second part", "Final part"]);
		expect(requests[0].messages.map(getMessageText)).toContain("First part");
		expect(requests[1].messages.filter((message) => message.role === "assistant").map(getMessageText)).toEqual([
			"First part",
			"Second part",
		]);
		expect(getMessageText(requests[0].messages.at(-1))).toContain("Continue exactly where it stopped");
		expect(
			harness.sessionManager
				.buildSessionContext()
				.messages.filter((message) => message.role === "assistant")
				.map(getMessageText),
		).toEqual(["First part", "Second part", "Final part"]);
		expect(
			harness
				.eventsOfType("message_end")
				.filter((event) => event.message.role === "assistant")
				.map((event) => getMessageText(event.message)),
		).toEqual(["First part", "Second part", "Final part"]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.session.isIdle).toBe(true);
	});

	it("continues when the output limit is reached during thinking", async () => {
		harness.setResponses([
			fauxAssistantMessage(fauxThinking("Partial reasoning"), { stopReason: "length" }),
			fauxAssistantMessage("Answer"),
		]);

		await harness.session.prompt("Solve the problem");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.messages.find((message) => message.role === "assistant")?.content).toEqual([
			fauxThinking("Partial reasoning"),
		]);
		expect(getAssistantTexts(harness).at(-1)).toBe("Answer");
	});

	it("honors cancellation after receiving a truncated response", async () => {
		harness.setResponses([fauxAssistantMessage("Partial answer", { stopReason: "length" })]);
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") void harness.session.abort();
		});

		await harness.session.prompt("Write a long answer");

		expect(harness.faux.state.callCount).toBe(1);
		expect(getAssistantTexts(harness)).toEqual(["Partial answer"]);
		expect(getUserTexts(harness)).toEqual(["Write a long answer"]);
	});

	it("retries output token limit errors and keeps the discovered cap for the session", async () => {
		harness.cleanup();
		harness = await createHarness({
			models: [{ id: "faux-1", maxTokens: 262_144 }],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
		});
		const retriedRequests: Array<{ modelMaxTokens: number; effectiveMaxTokens: number }> = [];
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage:
					'Error: 400: {"type":"invalid_request_error","message":"Output token limit must be between 1 and 131072","code":"unsupported_request","param":null}',
			}),
			(_context, options, _state, model) => {
				retriedRequests.push({
					modelMaxTokens: model.maxTokens,
					effectiveMaxTokens: options?.maxTokens ?? model.maxTokens,
				});
				return fauxAssistantMessage("Recovered");
			},
			fauxAssistantMessage("Next turn"),
		]);

		await harness.session.prompt("First request");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.state.model.maxTokens).toBe(131_072);
		expect(retriedRequests).toEqual([{ modelMaxTokens: 131_072, effectiveMaxTokens: 131_072 }]);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.errorMessage)).toEqual([
			'Error: 400: {"type":"invalid_request_error","message":"Output token limit must be between 1 and 131072","code":"unsupported_request","param":null}',
		]);

		await harness.session.prompt("Second request");

		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.state.model.maxTokens).toBe(131_072);
	});

	it.each(["steer", "followUp"] as const)("prioritizes queued %s input over the automatic prompt", async (method) => {
		harness.setResponses([
			fauxAssistantMessage("Partial answer", { stopReason: "length" }),
			fauxAssistantMessage("Updated answer"),
		]);
		harness.session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.stopReason === "length"
			) {
				void harness.session[method]("Changed request");
			}
		});

		await harness.session.prompt("Write a long answer");

		expect(harness.faux.state.callCount).toBe(2);
		expect(getUserTexts(harness)).toEqual(["Write a long answer", "Changed request"]);
	});

	it("rejects truncated tool calls and executes only the complete reissued call", async () => {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", {})], { stopReason: "length" }),
			fauxAssistantMessage([fauxToolCall("write", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		]);

		await harness.session.prompt("Write the file");

		expect(harness.faux.state.callCount).toBe(3);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toMatchObject([
			{ isError: true },
			{ isError: false },
		]);
		expect(getUserTexts(harness)).toEqual(["Write the file"]);
	});

	it.each(["stop", "error", "aborted"] as const)(
		"does not automatically continue a %s response",
		async (stopReason) => {
			harness.setResponses([fauxAssistantMessage("Existing output", { stopReason })]);

			await harness.session.prompt("Answer");

			expect(harness.faux.state.callCount).toBe(1);
			expect(getAssistantTexts(harness)).toEqual(["Existing output"]);
		},
	);

	it.each(["stop", "error", "aborted"] as const)(
		"prints all continuation chunks when the final response has reason %s",
		async (stopReason) => {
			const output = vi.spyOn(outputGuard, "writeRawStdout").mockImplementation(() => {});
			vi.spyOn(outputGuard, "flushRawStdout").mockResolvedValue(undefined);
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			const runtime = {
				session: harness.session,
				setRebindSession: vi.fn(),
				dispose: vi.fn(async () => {}),
			} as unknown as AgentSessionRuntime;
			harness.setResponses([
				fauxAssistantMessage("First ", { stopReason: "length" }),
				fauxAssistantMessage("second ", { stopReason: "length" }),
				fauxAssistantMessage("last", {
					stopReason,
					errorMessage: stopReason === "stop" ? undefined : "Interrupted",
				}),
			]);

			const exitCode = await runPrintMode(runtime, { mode: "text", initialMessage: "Write a long answer" });

			expect(output.mock.calls.map(([text]) => text).join("")).toBe("First second last\n");
			expect(exitCode).toBe(stopReason === "stop" ? 0 : 1);
			expect(error).toHaveBeenCalledTimes(stopReason === "stop" ? 0 : 1);
		},
	);

	it("keeps print mode limited to the final answer after successful intermediate responses", async () => {
		const output = vi.spyOn(outputGuard, "writeRawStdout").mockImplementation(() => {});
		vi.spyOn(outputGuard, "flushRawStdout").mockResolvedValue(undefined);
		const runtime = {
			session: harness.session,
			setRebindSession: vi.fn(),
			dispose: vi.fn(async () => {}),
		} as unknown as AgentSessionRuntime;
		harness.setResponses([fauxAssistantMessage("Earlier answer"), fauxAssistantMessage("Final answer")]);

		const exitCode = await runPrintMode(runtime, {
			mode: "text",
			initialMessage: "First request",
			messages: ["Next request"],
		});

		expect(output.mock.calls.map(([text]) => text).join("")).toBe("Final answer\n");
		expect(exitCode).toBe(0);
	});
});
