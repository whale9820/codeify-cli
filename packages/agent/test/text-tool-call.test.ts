import type { AssistantMessage } from "codeify-ai";
import { describe, expect, it } from "vitest";
import { convertTextToolCall } from "../src/text-tool-call.ts";

describe("text tool calls", () => {
	const message = (text: string) =>
		({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }) as AssistantMessage;
	it("converts the provided unescaped argument format", () => {
		const result = convertTextToolCall(
			message(
				`[assistant 请求调用 tool]\n[{"name": "browser", "arguments": "{"action": "eval", "script": "() => document.title"}"}]`,
			),
			["browser"],
		);
		expect(result.stopReason).toBe("toolUse");
		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			name: "browser",
			arguments: { action: "eval", script: "() => document.title" },
		});
	});

	it("leaves unknown, malformed, and truncated calls as text", () => {
		const input = message(`[assistant 请求调用 tool]\n[{"name":"browser","arguments":{}}]`);
		expect(convertTextToolCall(input, [])).toBe(input);
		expect(convertTextToolCall({ ...input, stopReason: "length" }, ["browser"]).stopReason).toBe("length");
		const invalid = message(`[assistant 请求调用 tool]\n[{"name":"browser","arguments":"{broken}"}]`);
		expect(convertTextToolCall(invalid, ["browser"])).toBe(invalid);
	});
});
