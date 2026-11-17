import { fauxAssistantMessage, fauxProvider, type Message } from "codeify-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import { parseTextToolCalls } from "../src/text-tool-calls.ts";
import type { AgentEvent, AgentTool } from "../src/types.ts";

const argKeyBash =
	'[assistant 请求调用工具]\n[{"name": "bash", "arguments</arg_key><arg_value>{"command": "journalctl -u qiangbei -n 8 --no-pager | tail -6; echo \'--- files ---\'"}"}]';
const argKeyEdits =
	'[assistant 请求调用工具]\n[{"name": "edit", "arguments</arg_key><arg_value>{"edits": [{"newText": "a = {\\"x\\": 1}\\n", "oldText": "b"}], "path": "/root/main.py"}"}, {"name": "edit",\n"arguments</arg_key><arg_value>{"edits": [{"newText": "}]", "oldText": "{"}], "path": "/root/d.html"}"}]</arg_value>';

describe("parseTextToolCalls", () => {
	it("parses arg_key envelopes", () => {
		expect(parseTextToolCalls(argKeyBash, ["bash"])).toEqual([
			{
				name: "bash",
				arguments: { command: "journalctl -u qiangbei -n 8 --no-pager | tail -6; echo '--- files ---'" },
			},
		]);
		expect(parseTextToolCalls(argKeyEdits, ["edit"])).toEqual([
			{ name: "edit", arguments: { edits: [{ newText: 'a = {"x": 1}\n', oldText: "b" }], path: "/root/main.py" } },
			{ name: "edit", arguments: { edits: [{ newText: "}]", oldText: "{" }], path: "/root/d.html" } },
		]);
	});

	it("parses JSON and unescaped-string envelopes", () => {
		expect(
			parseTextToolCalls('[assistant 请求调用 tool]\n[{"name":"bash","arguments":{"command":"ls"}}]', ["bash"]),
		).toEqual([{ name: "bash", arguments: { command: "ls" } }]);
		expect(
			parseTextToolCalls('[assistant 请求调用 tool]\n[{"name": "bash", "arguments": "{"command": "ls"}"}]', [
				"bash",
			]),
		).toEqual([{ name: "bash", arguments: { command: "ls" } }]);
	});

	it.each([
		['[{"name":"bash","arguments":{"command":"ls"}}]', ["bash"]],
		[argKeyBash, ["edit"]],
		[argKeyBash.slice(0, -4), ["bash"]],
		[`${argKeyBash} trailing`, ["bash"]],
	])("rejects unmarked, unknown, truncated, or trailing input %#", (text, names) => {
		expect(parseTextToolCalls(text, names)).toBeUndefined();
	});
});

describe("text tool-call marker", () => {
	it("executes a parsed text tool call as a structured call", async () => {
		const faux = fauxProvider({ tokenSize: { min: 1, max: 3 } });
		faux.setResponses([fauxAssistantMessage(argKeyBash), fauxAssistantMessage("done")]);
		const commands: string[] = [];
		const schema = Type.Object({ command: Type.String() });
		const bash: AgentTool<typeof schema> = {
			name: "bash",
			label: "Bash",
			description: "Run",
			parameters: schema,
			execute: async (_id, params) => {
				commands.push(params.command);
				return { content: [{ type: "text", text: "ok" }], details: undefined };
			},
		};
		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[{ role: "user", content: "Run it", timestamp: Date.now() }],
			{ systemPrompt: "", messages: [], tools: [bash] },
			{
				model: faux.getModel(),
				convertToLlm: (messages) =>
					messages.filter(
						(m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
					) as Message[],
			},
			undefined,
			faux.provider.streamSimple,
		);
		for await (const event of stream) events.push(event);
		expect(faux.state.callCount).toBe(2);
		expect(commands).toEqual(["journalctl -u qiangbei -n 8 --no-pager | tail -6; echo '--- files ---'"]);
		expect(JSON.stringify(events)).not.toContain("请求调用");
		const messages = await stream.result();
		expect(messages[1]).toMatchObject({
			role: "assistant",
			stopReason: "toolUse",
			content: [{ type: "toolCall", name: "bash" }],
		});
		expect(messages[2]).toMatchObject({ role: "toolResult", toolName: "bash", isError: false });
		expect(messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "done" }] });
	});
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
