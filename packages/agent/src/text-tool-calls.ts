import type { AssistantMessage, ToolCall } from "codeify-ai";

/** Prefixes of text-emitted tool-call envelopes, matched against the start of the assistant text. */
export const TEXT_TOOL_CALL_MARKERS = ["[assistant 请求调用 tool", "[assistant 请求调用工具"] as const;

export interface TextToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(value: unknown): Record<string, unknown> | undefined {
	if (isRecord(value)) return value;
	if (typeof value !== "string") return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function fromJson(value: unknown): TextToolCall[] | undefined {
	const list = Array.isArray(value)
		? value
		: isRecord(value) && Array.isArray(value.tool_calls)
			? value.tool_calls
			: [value];
	const calls: TextToolCall[] = [];
	for (const item of list) {
		if (!isRecord(item)) return undefined;
		const call = isRecord(item.function) ? item.function : item;
		const args = parseArgs(call.arguments ?? call.parameters);
		if (typeof call.name !== "string" || !args) return undefined;
		calls.push({ name: call.name, arguments: args });
	}
	return calls;
}

/** Returns the index after the JSON object starting at `start`, or -1 if it is unbalanced. */
function scanObject(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			if (char === "\\") i++;
			else if (char === '"') inString = false;
		} else if (char === '"') {
			inString = true;
		} else if (char === "{") {
			depth++;
		} else if (char === "}" && --depth === 0) {
			return i + 1;
		}
	}
	return -1;
}

/**
 * Lenient parser for envelopes whose arguments are unescaped JSON, e.g.
 * `[{"name": "bash", "arguments</arg_key><arg_value>{"command": "ls"}"}]` or
 * `[{"name": "bash", "arguments": "{"command": "ls"}"}]`.
 */
function fromMalformed(text: string): TextToolCall[] | undefined {
	const head =
		/^\s*\{\s*"name"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"(?:arguments|parameters)(?:"\s*:\s*"?|<\/arg_key>\s*<arg_value>)\s*/;
	const calls: TextToolCall[] = [];
	let i = /^\s*\[/.test(text) ? text.indexOf("[") + 1 : 0;
	while (true) {
		const match = head.exec(text.slice(i));
		if (!match) return undefined;
		i += match[0].length;
		if (text[i] !== "{") return undefined;
		const end = scanObject(text, i);
		if (end < 0) return undefined;
		const args = parseArgs(text.slice(i, end));
		if (!args) return undefined;
		calls.push({ name: JSON.parse(`"${match[1]}"`) as string, arguments: args });
		const tail = /^\s*(?:<\/arg_value>\s*)?"?\s*\}\s*([,\]]?)\s*/.exec(text.slice(end));
		if (!tail) return undefined;
		i = end + tail[0].length;
		if (tail[1] !== ",") return i === text.length ? calls : undefined;
	}
}

/** Parses a marker-prefixed text tool-call envelope. Returns undefined unless every call targets a known tool. */
export function parseTextToolCalls(text: string, toolNames: readonly string[]): TextToolCall[] | undefined {
	let body = text.trim();
	const marker = /^\[assistant\s*请求调用\s*(?:工具|tool)[^\]\n]*\]/i.exec(body);
	if (!marker) return undefined;
	body = body.slice(marker[0].length).trim();
	const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(body);
	if (fenced) body = fenced[1].trim();
	body = body
		.replace(/^<tool_call>/i, "")
		.replace(/(?:\s*<\/(?:arg_value|tool_call)>)+$/i, "")
		.trim();
	let calls: TextToolCall[] | undefined;
	try {
		calls = fromJson(JSON.parse(body));
	} catch {
		calls = fromMalformed(body);
	}
	if (!calls || calls.length === 0 || !calls.every((call) => toolNames.includes(call.name))) return undefined;
	return calls;
}

/** Replaces the text of a marker-prefixed assistant message with structured tool calls. */
export function convertTextToolCalls(
	message: AssistantMessage,
	toolNames: readonly string[],
): AssistantMessage | undefined {
	const text = message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
	const calls = parseTextToolCalls(text, toolNames);
	if (!calls) return undefined;
	const toolCalls: ToolCall[] = calls.map((call, index) => ({
		type: "toolCall",
		id: `text_call_${message.timestamp}_${index}`,
		name: call.name,
		arguments: call.arguments,
	}));
	return {
		...message,
		content: [...message.content.filter((part) => part.type !== "text"), ...toolCalls],
		stopReason: "toolUse",
	};
}
