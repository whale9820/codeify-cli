import { type AssistantMessage, contentText } from "codeify-ai";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCall(value: unknown, activeToolNames: readonly string[]): boolean {
	if (!isRecord(value)) return false;
	const call = isRecord(value.function) ? value.function : value;
	if (typeof call.name !== "string" || !activeToolNames.includes(call.name)) return false;
	const args = call.arguments ?? call.parameters;
	return isRecord(args) || (typeof args === "string" && /^\s*\{/.test(args));
}

export function hasTextToolCall(
	message: AssistantMessage,
	activeToolNames: readonly string[],
	userText: string,
): boolean {
	if (
		(message.stopReason !== "stop" && message.stopReason !== "length" && message.stopReason !== "toolUse") ||
		message.content.some(
			(part) => part.type === "toolCall" || part.type === "serverToolUse" || part.type === "serverToolResult",
		) ||
		activeToolNames.length === 0
	) {
		return false;
	}
	if (
		/\b(?:example|sample|transcript|documentation|quote|explain)\b|(?:示例|例子|解释|引用)/i.test(userText) ||
		/\b(?:return|output|show|print|generate)\b[^\n]{0,80}\b(?:json|tool[ -]?calls?)\b/i.test(userText)
	) {
		return false;
	}

	let text = contentText(message.content).trim();
	const marker = /^(?:\[assistant\s+tool[ _.-]?call\]|<tool_call>|tool[ _.-]?calls?\s*:)/i;
	const explicit = marker.test(text);
	text = text
		.replace(marker, "")
		.replace(/<\/tool_call>\s*$/i, "")
		.trim();
	const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text);
	if (fenced) text = fenced[1].trim();
	if (!/^[{[]/.test(text)) return false;
	try {
		const parsed: unknown = JSON.parse(text);
		if (Array.isArray(parsed)) {
			return parsed.length > 0 && parsed.every((call: unknown) => isCall(call, activeToolNames));
		}
		if (isRecord(parsed) && Array.isArray(parsed.tool_calls)) {
			return (
				parsed.tool_calls.length > 0 && parsed.tool_calls.every((call: unknown) => isCall(call, activeToolNames))
			);
		}
		return isCall(parsed, activeToolNames);
	} catch {
		if (!explicit) return false;
		const malformed =
			/^\[?\s*\{\s*"name"\s*:\s*"([^"\\]+)"\s*,\s*"(?:arguments|parameters)"\s*:\s*(?:\{|"\s*\{)/.exec(text);
		return malformed !== null && activeToolNames.includes(malformed[1]);
	}
}
