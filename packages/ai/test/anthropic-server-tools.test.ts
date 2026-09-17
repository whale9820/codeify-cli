import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { convertMessages, convertTools, stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import type {
	AssistantMessage,
	Context,
	Message,
	ServerToolResult,
	ServerToolUse,
	TextContent,
	Tool,
} from "../src/types.ts";

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		messages: {
			create: () => ({
				asResponse: async () => response,
			}),
		},
	} as unknown as Anthropic;
}

describe("Anthropic server tools (web search)", () => {
	it("parses server_tool_use and web_search_tool_result from SSE stream", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "What is the latest React version?", timestamp: Date.now() }],
		};

		const sseEvents = [
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_srv_test",
						usage: { input_tokens: 20, output_tokens: 0 },
					},
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "server_tool_use",
						id: "srvtoolu_123",
						name: "web_search",
						input: {},
					},
				}),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: {
						type: "input_json_delta",
						partial_json: '{"query": "latest React version"}',
					},
				}),
			},
			{
				event: "content_block_stop",
				data: JSON.stringify({ type: "content_block_stop", index: 0 }),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 1,
					content_block: {
						type: "web_search_tool_result",
						tool_use_id: "srvtoolu_123",
						content: [
							{
								type: "web_search_result",
								title: "React 19 Release",
								url: "https://react.dev/blog/2024/12/05/react-19",
							},
						],
					},
				}),
			},
			{
				event: "content_block_stop",
				data: JSON.stringify({ type: "content_block_stop", index: 1 }),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 2,
					content_block: { type: "text", text: "" },
				}),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 2,
					delta: { type: "text_delta", text: "React 19 was released recently." },
				}),
			},
			{
				event: "content_block_stop",
				data: JSON.stringify({ type: "content_block_stop", index: 2 }),
			},
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: { output_tokens: 35 },
				}),
			},
			{
				event: "message_stop",
				data: JSON.stringify({ type: "message_stop" }),
			},
		];

		const response = createSseResponse(sseEvents);
		const client = createFakeAnthropicClient(response);
		const stream = streamAnthropic(model, context, { client });
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toHaveLength(3);

		const serverToolUse = result.content[0] as ServerToolUse;
		expect(serverToolUse.type).toBe("serverToolUse");
		expect(serverToolUse.id).toBe("srvtoolu_123");
		expect(serverToolUse.name).toBe("web_search");
		expect(serverToolUse.input).toEqual({ query: "latest React version" });

		const serverToolResult = result.content[1] as ServerToolResult;
		expect(serverToolResult.type).toBe("serverToolResult");
		expect(serverToolResult.toolUseId).toBe("srvtoolu_123");
		expect(serverToolResult.resultType).toBe("web_search_tool_result");
		expect(Array.isArray(serverToolResult.content)).toBe(true);

		const textBlock = result.content[2] as TextContent;
		expect(textBlock.type).toBe("text");
		expect(textBlock.text).toBe("React 19 was released recently.");
	});

	it("converts serverToolUse and serverToolResult back to Anthropic format in convertMessages", () => {
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "serverToolUse",
					id: "srvtoolu_123",
					name: "web_search",
					input: { query: "vitest docs" },
				},
				{
					type: "serverToolResult",
					toolUseId: "srvtoolu_123",
					resultType: "web_search_tool_result",
					content: [{ title: "Vitest", url: "https://vitest.dev" }],
				},
				{
					type: "text",
					text: "Vitest is a Vite-native test framework.",
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-haiku-4-5",
			usage: {
				input: 10,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 30,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const messages: Message[] = [
			{ role: "user", content: "Search vitest", timestamp: Date.now() },
			assistantMessage,
			{ role: "user", content: "Tell me more", timestamp: Date.now() },
		];

		const converted = convertMessages(messages, false);
		expect(converted).toHaveLength(3);

		const assistantParam = converted[1];
		expect(assistantParam.role).toBe("assistant");
		expect(Array.isArray(assistantParam.content)).toBe(true);

		const contentBlocks = assistantParam.content as any[];
		expect(contentBlocks[0]).toEqual({
			type: "server_tool_use",
			id: "srvtoolu_123",
			name: "web_search",
			input: { query: "vitest docs" },
		});
		expect(contentBlocks[1]).toEqual({
			type: "web_search_tool_result",
			tool_use_id: "srvtoolu_123",
			content: [{ title: "Vitest", url: "https://vitest.dev" }],
		});
		expect(contentBlocks[2]).toEqual({
			type: "text",
			text: "Vitest is a Vite-native test framework.",
		});
	});

	it("converts web_search and websearch in convertTools to Anthropic server tool descriptor", () => {
		const tools: Tool[] = [
			{
				name: "web_search",
				description: "Search the web",
				parameters: {} as any,
			},
			{
				name: "websearch",
				description: "Search the web alias",
				parameters: {} as any,
			},
			{
				name: "bash",
				description: "Execute command",
				parameters: { properties: {}, required: [] } as any,
			},
		];

		const converted = convertTools(tools, false, true);
		expect(converted).toHaveLength(3);

		expect(converted[0]).toEqual({
			type: "web_search_20250305",
			name: "web_search",
		});
		expect(converted[1]).toEqual({
			type: "web_search_20250305",
			name: "web_search",
		});
		expect((converted[2] as any).name).toBe("bash");
		expect((converted[2] as any).input_schema).toBeDefined();
	});
});
