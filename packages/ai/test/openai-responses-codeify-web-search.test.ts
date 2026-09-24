import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-responses.ts";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const codeifyModel: Model<"openai-responses"> = {
	id: "gpt-6-astra",
	name: "gpt-6-astra",
	provider: "codeify",
	api: "openai-responses",
	baseUrl: "https://codeify.cc/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

function emptySse(): Response {
	return new Response("data: [DONE]\n\n", {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function captureRequestBody(
	model: Model<"openai-responses">,
	tools?: { name: string; description: string; parameters: ReturnType<typeof Type.Object> }[],
): Promise<unknown> {
	let body: unknown;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		body = JSON.parse(String(init?.body));
		return emptySse();
	});

	const response = stream(
		model,
		{
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			...(tools ? { tools } : {}),
		},
		{ apiKey: "test-key", maxRetries: 0 },
	);
	for await (const event of response) {
		if (event.type === "done" || event.type === "error") break;
	}
	return body;
}

describe("Codeify Responses web_search tool", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("includes hosted web_search when the request has no other tools", async () => {
		const body = (await captureRequestBody(codeifyModel)) as { tools?: unknown[] };
		expect(body.tools).toEqual([{ type: "web_search" }]);
	});

	it("appends hosted web_search alongside function tools", async () => {
		const body = (await captureRequestBody(codeifyModel, [
			{
				name: "read",
				description: "Read a file",
				parameters: Type.Object({ path: Type.String() }),
			},
		])) as { tools?: Array<{ type?: string; name?: string }> };

		expect(body.tools).toEqual([expect.objectContaining({ type: "function", name: "read" }), { type: "web_search" }]);
	});

	it("replaces a client web_search function with the hosted tool", async () => {
		const body = (await captureRequestBody(codeifyModel, [
			{
				name: "web_search",
				description: "Search the web",
				parameters: Type.Object({ query: Type.String() }),
			},
			{
				name: "read",
				description: "Read a file",
				parameters: Type.Object({ path: Type.String() }),
			},
		])) as { tools?: Array<{ type?: string; name?: string }> };

		expect(body.tools?.some((tool) => tool.type === "function" && tool.name === "web_search")).toBe(false);
		expect(body.tools).toEqual([expect.objectContaining({ type: "function", name: "read" }), { type: "web_search" }]);
	});

	it("leaves non-Codeify Responses requests unchanged", async () => {
		const body = (await captureRequestBody(getModel("openai", "gpt-5.4"))) as { tools?: unknown };
		expect(body.tools).toBeUndefined();
	});

	it("records web_search_call items as server tool events", async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: codeifyModel.api,
			provider: codeifyModel.provider,
			model: codeifyModel.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const searchItem = {
			type: "web_search_call",
			id: "ws_1",
			status: "completed",
			action: {
				type: "search",
				query: "codeify docs",
				sources: [{ type: "url", url: "https://codeify.cc" }],
			},
		};

		async function* events(): AsyncIterable<ResponseStreamEvent> {
			yield {
				type: "response.output_item.added",
				output_index: 0,
				item: { ...searchItem, status: "in_progress", action: { type: "search", query: "" } },
			} as ResponseStreamEvent;
			yield {
				type: "response.output_item.done",
				output_index: 0,
				item: searchItem,
			} as ResponseStreamEvent;
			yield {
				type: "response.output_text.delta",
				output_index: 1,
				content_index: 0,
				item_id: "msg_1",
				delta: "Found it.",
			} as ResponseStreamEvent;
			yield {
				type: "response.completed",
				response: {
					id: "resp_1",
					status: "completed",
					output: [
						searchItem,
						{
							type: "message",
							id: "msg_1",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "Found it.", annotations: [] }],
						},
					],
				},
			} as unknown as ResponseStreamEvent;
		}

		await processResponsesStream(events(), output, new AssistantMessageEventStream(), codeifyModel);

		expect(output.content).toEqual([
			{ type: "serverToolUse", id: "ws_1", name: "web_search", input: { query: "codeify docs" } },
			{
				type: "serverToolResult",
				toolUseId: "ws_1",
				resultType: "web_search_call",
				content: [{ type: "url", url: "https://codeify.cc" }],
			},
			{ type: "text", text: "Found it." },
		]);
		expect(output.stopReason).toBe("stop");
	});
});
