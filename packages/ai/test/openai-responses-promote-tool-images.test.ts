import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Context, Model, ToolResultMessage, Usage } from "../src/types.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createModel(promoteToolResultImages: boolean): Model<"openai-responses"> {
	return {
		id: "vision-model",
		name: "Vision Model",
		api: "openai-responses",
		provider: "codeify",
		baseUrl: "https://example.test/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
		compat: { promoteToolResultImages },
	};
}

function buildContext(model: Model<"openai-responses">): Context {
	const now = Date.now();
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "shot.png" } }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "toolUse",
		timestamp: now,
	};
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "tool-1",
		toolName: "read",
		content: [
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		],
		isError: false,
		timestamp: now + 1,
	};
	return {
		messages: [{ role: "user", content: "look at it", timestamp: now - 1 }, assistant, toolResult],
	};
}

describe("OpenAI Responses tool-result image promotion", () => {
	it("nests tool-result images in function_call_output by default", () => {
		const model = createModel(false);
		const input = convertResponsesMessages(model, buildContext(model), new Set(["codeify"]));
		const output = input.find((item) => (item as { type?: string }).type === "function_call_output") as {
			output: Array<{ type: string }>;
		};

		expect(output.output.map((part) => part.type)).toEqual(["input_text", "input_image"]);
		expect(input.filter((item) => (item as { role?: string }).role === "user")).toHaveLength(1);
	});

	it("promotes tool-result images into a following user message when compat requires it", () => {
		const model = createModel(true);
		const input = convertResponsesMessages(model, buildContext(model), new Set(["codeify"]));
		const outputIndex = input.findIndex((item) => (item as { type?: string }).type === "function_call_output");
		const output = input[outputIndex] as { output: string };
		const promoted = input[outputIndex + 1] as { role: string; content: Array<{ type: string; image_url?: string }> };

		expect(typeof output.output).toBe("string");
		expect(output.output).toContain("Read image file [image/png]");
		expect(output.output).toContain("image attached in the next message");
		expect(promoted.role).toBe("user");
		expect(promoted.content.map((part) => part.type)).toEqual(["input_text", "input_image"]);
		expect(promoted.content[1]?.image_url).toBe("data:image/png;base64,AAAA");
	});
});
