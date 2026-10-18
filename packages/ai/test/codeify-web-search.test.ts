import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import type { Context, Model, Tool } from "../src/types.ts";

type SearchApi = "anthropic-messages" | "openai-completions";

async function captureRequest(api: SearchApi, tools?: Tool[], provider = "codeify") {
	let body: Record<string, unknown> = {};
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		body = JSON.parse(String(init?.body));
		const data =
			api === "anthropic-messages"
				? 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
				: `data: ${JSON.stringify({ id: "chat_1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
		return new Response(data, { headers: { "content-type": "text/event-stream" } });
	});
	const model: Model<SearchApi> = {
		id: api === "anthropic-messages" ? "claude-sonnet-4-5" : "deepseek-v3",
		name: "test",
		provider,
		api,
		baseUrl: "https://codeify.cc/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
	const context: Context = { messages: [{ role: "user", content: "Search the web", timestamp: 0 }], tools };
	const options = { apiKey: "test-key", maxRetries: 0 };
	const response =
		api === "anthropic-messages"
			? streamAnthropic({ ...model, api }, context, options)
			: streamCompletions({ ...model, api }, context, options);
	expect((await response.result()).stopReason).toBe("stop");
	return body;
}

describe.each<SearchApi>(["anthropic-messages", "openai-completions"])("Codeify %s web search", (api) => {
	afterEach(() => vi.restoreAllMocks());

	it("enables server-side search without local tools", async () => {
		const body = await captureRequest(api);
		if (api === "anthropic-messages") {
			expect(body.tools).toEqual([{ type: "web_search_20250305", name: "web_search" }]);
		} else {
			expect(body.web_search_options).toEqual({});
			expect(body.tools).toBeUndefined();
		}
	});

	it.each(["web_search", "websearch", "search_web", "WebSearch"])(
		"uses hosted search alongside coding tools instead of the %s function",
		async (name) => {
			const body = await captureRequest(api, [
				{ name, description: "Search", parameters: Type.Object({ query: Type.String() }) },
				{ name: "read", description: "Read", parameters: Type.Object({ path: Type.String() }) },
			]);
			if (api === "anthropic-messages") {
				expect(body.tools).toEqual([
					expect.objectContaining({ name: "read", input_schema: expect.any(Object) }),
					{ type: "web_search_20250305", name: "web_search" },
				]);
			} else {
				expect(body.tools).toEqual([
					expect.objectContaining({ type: "function", function: expect.objectContaining({ name: "read" }) }),
				]);
				expect(body.web_search_options).toEqual({});
			}
		},
	);

	it("leaves other providers unchanged", async () => {
		const tool = { name: "search_web", description: "Search", parameters: Type.Object({ query: Type.String() }) };
		const body = await captureRequest(api, [tool], "other-provider");
		expect(body.web_search_options).toBeUndefined();
		expect(body.tools).toHaveLength(1);
		expect(body.tools).toEqual([
			expect.objectContaining(
				api === "anthropic-messages"
					? { name: tool.name }
					: { function: expect.objectContaining({ name: tool.name }) },
			),
		]);
	});
});

describe("Codeify openai-completions web search stream", () => {
	afterEach(() => vi.restoreAllMocks());

	it("surfaces server-side searches and keeps final usage", async () => {
		const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
			`data: ${JSON.stringify({ id: "chat_1", choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
		const body = [
			chunk({ role: "assistant", content: "Searching." }),
			chunk({}, { usage: { server_tool_use: { web_search_requests: 1 } } }),
			chunk({}, { usage: { server_tool_use: { web_search_requests: 2 } } }),
			chunk({ content: "Answer" }),
			`data: ${JSON.stringify({
				id: "chat_1",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 50, completion_tokens: 7, server_tool_use: { web_search_requests: 2 } },
			})}\n\n`,
			"data: [DONE]\n\n",
		].join("");
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
		);
		const model: Model<"openai-completions"> = {
			id: "deepseek-v3",
			name: "test",
			provider: "codeify",
			api: "openai-completions",
			baseUrl: "https://codeify.cc/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
		const response = streamCompletions(
			model,
			{ messages: [{ role: "user", content: "Search", timestamp: 0 }] },
			{ apiKey: "test-key", maxRetries: 0 },
		);
		const events: string[] = [];
		for await (const event of response) events.push(event.type);
		const message = await response.result();
		expect(message.content.map((block) => block.type)).toEqual([
			"text",
			"serverToolUse",
			"serverToolResult",
			"serverToolUse",
			"serverToolResult",
			"text",
		]);
		expect(message.content[1]).toMatchObject({ id: "chat_1_1", name: "web_search" });
		expect(message.content[4]).toMatchObject({ toolUseId: "chat_1_2" });
		expect(events.filter((type) => type === "server_tool_use_start")).toHaveLength(2);
		expect(events.filter((type) => type === "text_end")).toHaveLength(2);
		expect(message.usage).toMatchObject({ input: 50, output: 7 });
	});
});
