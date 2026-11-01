import { fauxAssistantMessage, fauxProvider } from "codeify-ai";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentEvent } from "../src/types.ts";

describe("text tool-call marker", () => {
	it("cuts off a split marker and regenerates without exposing it", async () => {
		const faux = fauxProvider({ tokenSize: { min: 1, max: 1 } });
		let aborted = false;
		faux.setResponses([
			(_context, options) => {
				options?.signal?.addEventListener("abort", () => {
					aborted = true;
				});
				return fauxAssistantMessage('[assistant 请求调用 tool]\n[{"name":"bash","arguments":{}}]');
			},
			fauxAssistantMessage("done"),
		]);
		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[{ role: "user", content: "Run it", timestamp: Date.now() }],
			{ systemPrompt: "", messages: [], tools: [] },
			{ model: faux.getModel(), convertToLlm: (messages) => messages.filter((m) => m.role === "user") },
			undefined,
			faux.provider.streamSimple,
		);
		for await (const event of stream) events.push(event);
		expect(faux.state.callCount).toBe(2);
		expect(aborted).toBe(true);
		expect(JSON.stringify(events)).not.toContain("请求调用");
		expect((await stream.result()).at(-1)).toMatchObject({ content: [{ type: "text", text: "done" }] });
	});

	it("stops after repeated markers", async () => {
		const faux = fauxProvider();
		faux.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("[assistant 请求调用 tool]")));
		const stream = agentLoop(
			[{ role: "user", content: "Run it", timestamp: Date.now() }],
			{ systemPrompt: "", messages: [], tools: [] },
			{ model: faux.getModel(), convertToLlm: (messages) => messages.filter((m) => m.role === "user") },
			undefined,
			faux.provider.streamSimple,
		);
		const messages = await stream.result();
		expect(faux.state.callCount).toBe(3);
		expect(messages.at(-1)).toMatchObject({ stopReason: "error", content: [] });
	});

	it("streams thinking before filtering a marker and retains one assistant message", async () => {
		const faux = fauxProvider({ tokenSize: { min: 1, max: 1 } });
		faux.setResponses([
			fauxAssistantMessage([
				{ type: "thinking", thinking: "Checking" },
				{ type: "text", text: "[assistant 请求调用 tool]" },
			]),
			fauxAssistantMessage("done"),
		]);
		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[{ role: "user", content: "Run it", timestamp: Date.now() }],
			{ systemPrompt: "", messages: [], tools: [] },
			{ model: faux.getModel(), convertToLlm: (messages) => messages.filter((m) => m.role === "user") },
			undefined,
			faux.provider.streamSimple,
		);
		for await (const event of stream) events.push(event);
		expect(faux.state.callCount).toBe(2);
		expect(JSON.stringify(events)).not.toContain("请求调用");
		expect(
			events.some(
				(event) => event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta",
			),
		).toBe(true);
		expect(
			events.filter((event) => event.type === "message_start" && event.message.role === "assistant"),
		).toHaveLength(1);
		expect((await stream.result()).filter((message) => message.role === "assistant")).toHaveLength(1);
	});
});
