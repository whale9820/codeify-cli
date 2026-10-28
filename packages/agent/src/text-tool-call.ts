import type { AssistantMessage, ToolCall } from "codeify-ai";

export function convertTextToolCall(message: AssistantMessage, toolNames: readonly string[]): AssistantMessage {
	if (message.stopReason !== "stop" || message.content.length !== 1 || message.content[0].type !== "text")
		return message;
	const match = /^\s*\[assistant\s+请求调用\s+tool\]\s*([\s\S]+?)\s*$/.exec(message.content[0].text);
	if (!match) return message;
	let parsed: unknown;
	try {
		parsed = JSON.parse(match[1]);
	} catch {
		const malformed = /^\[\s*\{\s*"name"\s*:\s*"([^"\\]+)"\s*,\s*"arguments"\s*:\s*"(\{[\s\S]*\})"\s*\}\s*\]$/.exec(
			match[1],
		);
		if (!malformed) return message;
		try {
			parsed = [{ name: malformed[1], arguments: JSON.parse(malformed[2]) }];
		} catch {
			return message;
		}
	}
	if (!Array.isArray(parsed) || parsed.length === 0) return message;
	const calls: ToolCall[] = [];
	for (const item of parsed) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return message;
		const call = item as Record<string, unknown>;
		if (typeof call.name !== "string" || !toolNames.includes(call.name)) return message;
		let args = call.arguments;
		if (typeof args === "string") {
			try {
				args = JSON.parse(args);
			} catch {
				return message;
			}
		}
		if (!args || typeof args !== "object" || Array.isArray(args)) return message;
		calls.push({
			type: "toolCall",
			id: crypto.randomUUID(),
			name: call.name,
			arguments: args as Record<string, unknown>,
		});
	}
	return { ...message, content: calls, stopReason: "toolUse" };
}
