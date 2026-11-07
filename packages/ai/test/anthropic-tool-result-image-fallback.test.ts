import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Context, Model } from "../src/types.ts";

const sseBody = [
	{
		type: "message_start",
		message: {
			id: "msg_test",
			usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
	{ type: "message_stop" },
]
	.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`)
	.join("\n");

function makeModel(id: string): Model<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "vendor-proxy",
		baseUrl: "http://127.0.0.1:9",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 4096,
	};
}

function makeContext(): Context {
	return {
		messages: [
			{ role: "user", content: "Read the image", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.png" } }],
				api: "anthropic-messages",
				provider: "vendor-proxy",
				model: "m",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "read",
				content: [
					{ type: "text", text: "Read image file [image/png]" },
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				],
				isError: false,
				timestamp: 3,
			},
		],
	};
}

function toolResultHasImage(params: MessageCreateParamsStreaming): boolean {
	return params.messages.some(
		(message) =>
			Array.isArray(message.content) &&
			message.content.some(
				(block) =>
					block.type === "tool_result" &&
					Array.isArray(block.content) &&
					block.content.some((inner) => inner.type === "image"),
			),
	);
}

/** Fake client that rejects images nested in tool_result like the affected providers. */
function createRejectingClient(requests: MessageCreateParamsStreaming[], rejectAll = false): Anthropic {
	return {
		messages: {
			create: (params: MessageCreateParamsStreaming) => ({
				asResponse: async () => {
					requests.push(params);
					if (rejectAll || toolResultHasImage(params)) {
						const body = {
							error: { message: "Invalid request parameter", type: "invalid_request_error" },
							type: "error",
						};
						throw Anthropic.APIError.generate(400, body, undefined, new Headers());
					}
					return new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
				},
			}),
		},
	} as unknown as Anthropic;
}

describe("Anthropic tool-result image fallback", () => {
	it("moves tool-result images into user content after a 400 and remembers it for the session", async () => {
		const model = makeModel("fallback-model");
		const requests: MessageCreateParamsStreaming[] = [];
		const client = createRejectingClient(requests);

		const first = await streamAnthropic(model, makeContext(), { client, sessionId: "session-a" }).result();
		expect(first.stopReason).toBe("stop");
		expect(first.content).toEqual([{ type: "text", text: "ok" }]);
		expect(requests).toHaveLength(2);
		expect(toolResultHasImage(requests[0])).toBe(true);
		expect(toolResultHasImage(requests[1])).toBe(false);

		const lastUser = requests[1].messages[requests[1].messages.length - 1];
		expect(Array.isArray(lastUser.content)).toBe(true);
		const blocks = lastUser.content as Exclude<typeof lastUser.content, string>;
		expect(blocks[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_1" });
		expect(blocks[0]).toMatchObject({ content: "Read image file [image/png]" });
		expect(blocks.slice(1).map((block) => block.type)).toEqual(["text", "image"]);

		// Same session: no failing request, layout applied up front.
		const second = await streamAnthropic(model, makeContext(), { client, sessionId: "session-a" }).result();
		expect(second.stopReason).toBe("stop");
		expect(requests).toHaveLength(3);
		expect(toolResultHasImage(requests[2])).toBe(false);

		// A different session detects again.
		await streamAnthropic(model, makeContext(), { client, sessionId: "session-b" }).result();
		expect(requests).toHaveLength(5);
		expect(toolResultHasImage(requests[3])).toBe(true);
	});

	it("surfaces the error and does not persist when the fallback also fails", async () => {
		const model = makeModel("always-failing-model");
		const requests: MessageCreateParamsStreaming[] = [];
		const client = createRejectingClient(requests, true);

		const result = await streamAnthropic(model, makeContext(), { client, sessionId: "session-c" }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Invalid request parameter");
		expect(requests).toHaveLength(2);

		await streamAnthropic(model, makeContext(), { client, sessionId: "session-c" }).result();
		expect(requests).toHaveLength(4);
		expect(toolResultHasImage(requests[2])).toBe(true);
	});

	it("does not retry 400s when no tool result carries an image", async () => {
		const model = makeModel("no-image-model");
		const requests: MessageCreateParamsStreaming[] = [];
		const client = createRejectingClient(requests, true);
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

		const result = await streamAnthropic(model, context, { client, sessionId: "session-d" }).result();
		expect(result.stopReason).toBe("error");
		expect(requests).toHaveLength(1);
	});
});
