import { createAssistantMessageEventStream, fauxAssistantMessage } from "codeify-ai";
import { streamSimple } from "codeify-ai/compat";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { streamWithIdleTimeout } from "../../src/core/stream-idle-timeout.ts";
import { createHarness } from "./harness.ts";

afterEach(() => vi.useRealTimers());

it("executes a recovered tool exactly once, persists its result, and completes without retry", async () => {
	const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined }));
	const harness = await createHarness({
		tools: [
			{
				name: "bash",
				label: "Bash",
				description: "Test shell",
				parameters: Type.Object({ command: Type.String() }),
				execute,
			},
		],
		settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
	});
	vi.useFakeTimers();
	try {
		harness.setResponses([
			fauxAssistantMessage([{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "printf ok" } }], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Command completed."),
		]);
		let requests = 0;
		harness.session.agent.streamFunction = (model, context, options) => {
			requests++;
			if (requests > 1) return streamSimple(model, context, options);
			return streamWithIdleTimeout(model, { ...options, timeoutMs: 1000 }, async (signal) => {
				const stalled = createAssistantMessageEventStream();
				const upstream = streamSimple(model, context, { ...options, signal });
				void (async () => {
					for await (const event of upstream) {
						if (event.type !== "done") stalled.push(event);
					}
				})();
				return stalled;
			});
		};
		const prompt = harness.session.prompt("Run the test command.");
		await vi.advanceTimersByTimeAsync(1001);
		await prompt;
		expect(execute).toHaveBeenCalledOnce();
		expect(requests).toBe(2);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expect(harness.eventsOfType("tool_execution_end")).toHaveLength(1);
		expect(harness.session.messages.at(-1)).toMatchObject({
			stopReason: "stop",
			content: [{ text: "Command completed." }],
		});
		expect(JSON.stringify(harness.sessionManager.getEntries())).toContain('"role":"toolResult"');
		expect(harness.session.isStreaming).toBe(false);
	} finally {
		harness.cleanup();
	}
});
