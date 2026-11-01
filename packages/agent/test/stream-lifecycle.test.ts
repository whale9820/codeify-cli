import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider } from "codeify-ai";
import { describe, expect, it, vi } from "vitest";
import { agentLoop, runAgentLoop } from "../src/agent-loop.ts";
import type { AgentEvent } from "../src/types.ts";

const model = fauxProvider().getModel();
const prompt = { role: "user" as const, content: "Hello", timestamp: Date.now() };
const context = { systemPrompt: "", messages: [], tools: [] };
const config = { model, convertToLlm: () => [prompt] };

describe("stream lifecycle", () => {
	it.each([false, true])(
		"finishes when stream setup throws (async: %s)",
		async (asynchronous) => {
			const failure = () => {
				throw new Error("Connection refused");
			};
			const stream = agentLoop([prompt], context, config, undefined, asynchronous ? async () => failure() : failure);
			const events: AgentEvent[] = [];
			for await (const event of stream) events.push(event);
			expect((await stream.result()).at(-1)).toMatchObject({
				stopReason: "error",
				errorMessage: "Connection refused",
			});
			expect(events.at(-1)?.type).toBe("agent_end");
		},
		1000,
	);

	it("finishes when stream iteration throws and preserves partial output", async () => {
		const source = createAssistantMessageEventStream();
		const partial = fauxAssistantMessage("partial");
		vi.spyOn(source, Symbol.asyncIterator).mockImplementation(async function* () {
			yield { type: "start", partial };
			yield { type: "text_delta", contentIndex: 0, delta: "partial", partial };
			throw new Error("RemoteProtocolError");
		});
		const stream = agentLoop([prompt], context, config, undefined, () => source);
		expect((await stream.result()).at(-1)).toMatchObject({
			content: [{ type: "text", text: "partial" }],
			stopReason: "error",
			errorMessage: "RemoteProtocolError",
		});
	}, 1000);

	it("delivers thinking before the response finishes", async () => {
		const source = createAssistantMessageEventStream();
		const events: AgentEvent[] = [];
		const running = runAgentLoop(
			[prompt],
			context,
			config,
			(event) => {
				events.push(event);
			},
			undefined,
			() => source,
		);
		const partial = fauxAssistantMessage([{ type: "thinking", thinking: "Checking" }]);
		source.push({ type: "start", partial: fauxAssistantMessage("") });
		source.push({ type: "thinking_start", contentIndex: 0, partial });
		source.push({ type: "thinking_delta", contentIndex: 0, delta: "Checking", partial });
		try {
			await vi.waitFor(
				() => {
					expect(
						events.some(
							(event) =>
								event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta",
						),
					).toBe(true);
				},
				{ timeout: 500 },
			);
		} finally {
			source.push({ type: "done", reason: "stop", message: fauxAssistantMessage("Done") });
			await running;
		}
	});
});
