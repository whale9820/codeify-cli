import { describe, expect, test } from "vitest";
import { splitWrappedThinking } from "../src/utils/thinking-text.ts";

describe("splitWrappedThinking", () => {
	test("returns plain text as a single text segment", () => {
		expect(splitWrappedThinking("just a normal answer")).toEqual([{ type: "text", text: "just a normal answer" }]);
	});

	test("splits <think> tags into a thinking segment", () => {
		expect(splitWrappedThinking("a <think>hidden</think> b")).toEqual([
			{ type: "text", text: "a" },
			{ type: "thinking", text: "hidden" },
			{ type: "text", text: "b" },
		]);
	});

	test("splits <thinking> tags into a thinking segment", () => {
		expect(splitWrappedThinking("a <thinking>hidden</thinking> b")).toEqual([
			{ type: "text", text: "a" },
			{ type: "thinking", text: "hidden" },
			{ type: "text", text: "b" },
		]);
	});

	test("handles both tag styles in one text", () => {
		expect(splitWrappedThinking("one <think>a</think> two <thinking>b</thinking> three")).toEqual([
			{ type: "text", text: "one" },
			{ type: "thinking", text: "a" },
			{ type: "text", text: "two" },
			{ type: "thinking", text: "b" },
			{ type: "text", text: "three" },
		]);
	});

	test("treats an unclosed opening tag as thinking through the end", () => {
		expect(splitWrappedThinking("prose <think>still reasoning...")).toEqual([
			{ type: "text", text: "prose" },
			{ type: "thinking", text: "still reasoning..." },
		]);
	});

	test("trims whitespace and newlines around segments", () => {
		expect(splitWrappedThinking("\nprose\n\n<think>\nreasoning\n</think>\n\ntail\n")).toEqual([
			{ type: "text", text: "prose" },
			{ type: "thinking", text: "reasoning" },
			{ type: "text", text: "tail" },
		]);
	});

	test("ignores empty thinking spans", () => {
		expect(splitWrappedThinking("a </think> b")).toEqual([{ type: "text", text: "a </think> b" }]);
		expect(splitWrappedThinking("a <thinking></thinking> b")).toEqual([
			{ type: "text", text: "a" },
			{ type: "text", text: "b" },
		]);
	});

	test("matches tags case-insensitively", () => {
		expect(splitWrappedThinking("a <think>upper</think> b")).toEqual([
			{ type: "text", text: "a" },
			{ type: "thinking", text: "upper" },
			{ type: "text", text: "b" },
		]);
	});

	test("returns no segments for whitespace-only text", () => {
		expect(splitWrappedThinking("  \n ")).toEqual([]);
		expect(splitWrappedThinking("")).toEqual([]);
	});
});
