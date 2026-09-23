import type { AssistantMessage } from "codeify-ai";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

const THINKING_OPEN = "<think>";
const THINKING_CLOSE = "</think>";

function createAssistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "stopReason" | "errorMessage">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: overrides.stopReason ?? "stop",
		errorMessage: overrides.errorMessage,
		timestamp: Date.now(),
	};
}

describe("AssistantMessageComponent", () => {
	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("renders length stops as visible errors", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }], { stopReason: "length" }),
			true,
		);
		const rendered = component.render(80).join("\n");

		expect(rendered).toContain("private reasoning");
		expect(rendered).toContain("maximum output token limit");
		expect(rendered).toContain("response may be incomplete");
	});

	test("renders adjacent thinking blocks in order", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first thought" },
				{ type: "thinking", thinking: "" },
				{ type: "thinking", thinking: "second thought" },
				{ type: "text", text: "answer" },
			]),
			true,
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).toContain("first thought");
		expect(rendered).toContain("second thought");
		expect(rendered).toContain("answer");
	});

	test.each([
		"Expected ':' after property name in JSON at position 4058",
		"Error: Expected ',' or '}' after property value in JSON at position 4077 (line 1 column 4078)",
		"Expected ',' or '}' after property value in JSON at position 8184 (line 1 column 8185)",
		"Unterminated string in JSON at position 2621",
		"Expected double-quoted property name in JSON at position 21751",
	])("collapses %s diagnostics until expanded", (parseError) => {
		initTheme("dark");

		const errorMessage = `${parseError}\n${"diagnostic-payload ".repeat(4000)}`;
		const component = new AssistantMessageComponent(
			createAssistantMessage([], { stopReason: "error", errorMessage }),
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("Response interrupted");
		expect(collapsed).not.toContain(errorMessage);

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain(parseError);
		expect(expanded).toContain("diagnostic-payload");
		component.setExpanded(false);
		expect(component.render(80).length).toBeLessThan(5);
	});

	test("uses configured output padding for text and thinking", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "reasoning" },
			]),
			false,
			undefined,
			"Thinking...",
			1,
		);
		const lines = component.render(80).map((line) => stripAnsi(line));

		expect(lines.some((line) => line.includes(" hello"))).toBe(true);
		expect(lines.some((line) => line.includes(" reasoning"))).toBe(true);

		component.setOutputPad(0);
		const updatedLines = component.render(80).map((line) => stripAnsi(line));
		expect(updatedLines.some((line) => line.startsWith("hello"))).toBe(true);
		expect(updatedLines.some((line) => line.startsWith("reasoning"))).toBe(true);
	});

	test("uses configured output padding for user messages", () => {
		initTheme("dark");

		const paddedComponent = new UserMessageComponent("hello", undefined, 1);
		const paddedLines = paddedComponent.render(40).map((line) => stripAnsi(line));
		expect(paddedLines.some((line) => line.startsWith(" hello"))).toBe(true);

		const unpaddedComponent = new UserMessageComponent("hello", undefined, 0);
		const unpaddedLines = unpaddedComponent.render(40).map((line) => stripAnsi(line));
		expect(unpaddedLines.some((line) => line.startsWith("hello"))).toBe(true);
	});

	test("renders model text wrapped in thinking tags as thinking", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{
					type: "text",
					text: `Here is prose.\n\n${THINKING_OPEN}hidden reasoning here${THINKING_CLOSE}\n\nAnd the answer.`,
				},
			]),
		);
		const rendered = component.render(80).join("\n");
		const stripped = stripAnsi(rendered);

		expect(rendered).toContain(theme.fg("thinkingText", "hidden reasoning here"));
		expect(stripped).not.toContain(THINKING_OPEN);
		expect(stripped).not.toContain(THINKING_CLOSE);
		expect(stripped).toContain("Here is prose.");
		expect(stripped).toContain("And the answer.");
	});

	test("renders model text wrapped in <thinking> tags as thinking", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{
					type: "text",
					text: "Here is prose.\n\n<thinking>hidden reasoning here</thinking>\n\nAnd the answer.",
				},
			]),
		);
		const rendered = component.render(80).join("\n");
		const stripped = stripAnsi(rendered);

		expect(rendered).toContain(theme.fg("thinkingText", "hidden reasoning here"));
		expect(stripped).not.toContain("<thinking>");
		expect(stripped).not.toContain("</thinking>");
		expect(stripped).toContain("Here is prose.");
		expect(stripped).toContain("And the answer.");
	});

	test("renders an unclosed thinking tag as thinking while streaming", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{
					type: "text",
					text: `Answer so far.\n\n${THINKING_OPEN}partial reasoning still arriving`,
				},
			]),
		);
		const rendered = component.render(80).join("\n");
		const stripped = stripAnsi(rendered);

		expect(rendered).toContain(theme.fg("thinkingText", "partial reasoning still arriving"));
		expect(stripped).toContain("Answer so far.");
		expect(stripped).not.toContain(THINKING_OPEN);
	});

	test("renders adjacent bold spans in thinking on separate lines", () => {
		initTheme("dark");

		const thinking = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "**First step****Second step**" }]),
		);
		const lines = thinking.render(80).map((line) => stripAnsi(line).trimEnd());
		const first = lines.findIndex((line) => line.includes("First step"));
		const second = lines.findIndex((line) => line.includes("Second step"));

		expect(first).toBeGreaterThanOrEqual(0);
		expect(second).toBeGreaterThan(first);
		expect(lines.slice(first, second).some((line) => line.trim() === "")).toBe(true);
		for (const line of lines) {
			expect(line).not.toContain("****");
		}
	});

	test("renders adjacent bold spans in plain assistant text on separate lines", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "**First step****Second step**" }]),
		);
		const lines = component.render(80).map((line) => stripAnsi(line).trimEnd());
		const first = lines.findIndex((line) => line.includes("First step"));
		const second = lines.findIndex((line) => line.includes("Second step"));

		expect(first).toBeGreaterThanOrEqual(0);
		expect(second).toBeGreaterThan(first);
		expect(lines.slice(first, second).some((line) => line.trim() === "")).toBe(true);
	});

	test("styles wrapped thinking like a real thinking block", () => {
		initTheme("dark");

		const wrapped = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: `${THINKING_OPEN}same styling${THINKING_CLOSE}` }]),
		);
		const real = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "same styling" }]),
		);

		expect(wrapped.render(80).join("\n")).toContain(theme.fg("thinkingText", "same styling"));
		expect(real.render(80).join("\n")).toContain(theme.fg("thinkingText", "same styling"));
	});
});
