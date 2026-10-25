import { fauxAssistantMessage, fauxToolCall } from "codeify-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../../src/core/messages.ts";
import { hasTextToolCall } from "../../src/core/text-tool-call.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const rawCall = '[{"name":"bash","arguments":{"command":"printf ok"}}]';
const malformedCall =
	'[assistant 请求调用 tool]\n[{"name": "bash", "arguments": "{"command": "printf ok", "timeout": 25}"}]';

describe("text tool-call detection", () => {
	it.each([
		rawCall,
		malformedCall,
		'```json\n{"name":"bash","parameters":{"command":"printf ok"}}\n```',
		'<tool_call>{"name":"bash","arguments":"{\\"command\\":\\"printf ok\\"}"}</tool_call>',
		'{"tool_calls":[{"type":"function","function":{"name":"bash","arguments":{"command":"printf ok"}}}]}',
	])("recognizes invocation envelopes: %s", (text) => {
		expect(hasTextToolCall(fauxAssistantMessage(text), ["bash"], "Check the project")).toBe(true);
	});

	it.each([
		"The tool_calls field contains function invocations.",
		`Example:\n${rawCall}`,
		`> ${rawCall}`,
		`The agent emitted this:\n${malformedCall}`,
		'{"name":"disabled","arguments":{}}',
		'{"name":"bash"}',
		'{"name":"bash","arguments":null}',
		'{"name":"bash","arguments":{"command":"printf ok"}',
		'[{"name":"bash","arguments":{}},{"name":"disabled","arguments":{}}]',
	])("rejects discussion and insufficient evidence: %s", (text) => {
		expect(hasTextToolCall(fauxAssistantMessage(text), ["bash"], "Check the project")).toBe(false);
	});

	it.each(["Explain tool calls", "Show a JSON example", "Return JSON representing a tool call", "解释这个调用"])(
		"suppresses requested examples: %s",
		(userText) => {
			expect(hasTextToolCall(fauxAssistantMessage(rawCall), ["bash"], userText)).toBe(false);
		},
	);

	it.each(["error", "aborted"] as const)("ignores %s responses", (stopReason) => {
		expect(hasTextToolCall(fauxAssistantMessage(rawCall, { stopReason }), ["bash"], "Check the project")).toBe(false);
	});

	it("ignores responses containing real or server tool activity", () => {
		for (const part of [
			fauxToolCall("bash", {}),
			{ type: "serverToolUse" as const, id: "search-1", name: "web_search", input: {} },
			{ type: "serverToolResult" as const, toolUseId: "search-1", content: [] },
		]) {
			const message = fauxAssistantMessage(rawCall);
			message.content.push(part);
			expect(hasTextToolCall(message, ["bash"], "Check the project")).toBe(false);
		}
	});
});

describe("text tool-call recovery", () => {
	let harness: Harness;
	const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }));
	const convert = vi.fn(convertToLlm);

	beforeEach(async () => {
		execute.mockClear();
		convert.mockClear();
		harness = await createHarness({
			tools: [{ name: "bash", label: "Bash", description: "Test tool", parameters: Type.Object({}), execute }],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
		});
		harness.session.agent.convertToLlm = convert;
	});

	afterEach(() => harness.cleanup());

	it("continues with a persisted model-visible correction and executes only a real reissued call", async () => {
		harness.setResponses([
			fauxAssistantMessage(malformedCall),
			fauxAssistantMessage([fauxToolCall("bash", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Check the project");
		expect(harness.faux.state.callCount).toBe(3);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.session.isIdle).toBe(true);
		expect(convert.mock.results[1].value.at(-1)).toMatchObject({ role: "user" });
		expect(getMessageText(convert.mock.results[1].value.at(-1))).toContain("No structured tool call was received");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toMatchObject([
			{ customType: "tool_call_recovery" },
		]);
	});

	it("stops on a repeated candidate without executing text", async () => {
		harness.setResponses([fauxAssistantMessage(rawCall), fauxAssistantMessage(rawCall)]);
		await harness.session.prompt("Check the project");
		expect(harness.faux.state.callCount).toBe(2);
		expect(execute).not.toHaveBeenCalled();
	});

	it("caps different recovery candidates and resets for a new user request", async () => {
		harness.setResponses([
			...Array.from({ length: 3 }, (_, index) =>
				fauxAssistantMessage(rawCall.replace("printf ok", `printf ${index}`)),
			),
			fauxAssistantMessage(rawCall),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Check the project");
		expect(harness.faux.state.callCount).toBe(3);
		await harness.session.prompt("Check again");
		expect(harness.faux.state.callCount).toBe(5);
	});

	it("honors cancellation after the final assistant message", async () => {
		harness.setResponses([fauxAssistantMessage(rawCall)]);
		harness.session.subscribe((event) => {
			if (event.type === "agent_end") void harness.session.abort();
		});
		await harness.session.prompt("Check the project");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("gives queued user messages priority over recovery", async () => {
		harness.setResponses([fauxAssistantMessage(rawCall), fauxAssistantMessage("done")]);
		let queued = false;
		harness.session.subscribe((event) => {
			if (event.type === "agent_end" && !queued) {
				queued = true;
				void harness.session.followUp("Changed request");
			}
		});
		await harness.session.prompt("Check the project");
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);
	});
});
