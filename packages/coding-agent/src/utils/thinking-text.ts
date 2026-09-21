export interface WrappedThinkingSegment {
	type: "text" | "thinking";
	text: string;
}

const WRAPPED_THINKING_PATTERN = /<think>([\s\S]*?)(?:<\/think>|$)|<thinking>([\s\S]*?)(?:<\/thinking>|$)/gi;

/**
 * Split assistant text into plain-text and thinking segments.
 *
 * Models without a structured reasoning channel sometimes emit their reasoning
 * wrapped in `<think>...</think>` or `<thinking>...</thinking>` tags inside the
 * regular text stream. An opening tag that is never closed is treated as
 * thinking through the end of the text so in-progress reasoning already renders
 * as thinking while the message is still streaming.
 */
export function splitWrappedThinking(text: string): WrappedThinkingSegment[] {
	const segments: WrappedThinkingSegment[] = [];
	let lastIndex = 0;

	for (const match of text.matchAll(WRAPPED_THINKING_PATTERN)) {
		const start = match.index ?? 0;
		const before = text.slice(lastIndex, start);
		if (before.trim()) {
			segments.push({ type: "text", text: before.trim() });
		}
		const thinking = (match[1] ?? match[2] ?? "").trim();
		if (thinking) {
			segments.push({ type: "thinking", text: thinking });
		}
		lastIndex = start + match[0].length;
	}

	const rest = text.slice(lastIndex);
	if (rest.trim()) {
		segments.push({ type: "text", text: rest.trim() });
	}

	return segments;
}
