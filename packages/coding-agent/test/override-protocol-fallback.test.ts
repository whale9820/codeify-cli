import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Context, Provider } from "codeify-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toModelDefinition } from "../src/core/codeify-provider.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { overrideProviderConfig } from "../src/core/overrides.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";

describe("override protocol fallback", () => {
	let server: Server;
	let baseUrl: string;
	let paths: string[];
	let statuses: Record<string, number>;
	let modelConfig: ModelConfig;
	const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

	beforeEach(async () => {
		modelConfig = await ModelConfig.load(undefined);
		paths = [];
		statuses = {};
		server = createServer((request, response) => {
			const path = request.url!;
			paths.push(path);
			const status = statuses[path] ?? 404;
			if (status === 200) {
				response.writeHead(200, { "content-type": "text/event-stream" });
				if (path === "/v1/messages") {
					const events = [
						{
							type: "message_start",
							message: {
								id: "msg",
								type: "message",
								role: "assistant",
								model: "other",
								content: [],
								usage: { input_tokens: 1, output_tokens: 0 },
							},
						},
						{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
						{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
						{ type: "content_block_stop", index: 0 },
						{
							type: "message_delta",
							delta: { stop_reason: "end_turn", stop_sequence: null },
							usage: { output_tokens: 1 },
						},
						{ type: "message_stop" },
					];
					response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
					return;
				}
				response.end(
					`data: ${JSON.stringify({ id: "chat", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "chat", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
				);
			} else {
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: "Endpoint unavailable", type: "not_found_error" } }));
			}
		});
		await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	});

	afterEach(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});

	function provider(id: string, fallback = true): Provider {
		const config = overrideProviderConfig({
			name: "local",
			baseUrl,
			apiKey: "secret",
			models: [toModelDefinition({ id })],
		});
		config.overrideProtocolFallback = fallback;
		return composeModelProvider("override-local", undefined, modelConfig, config);
	}

	it.each(["stream", "streamSimple"] as const)("%s falls back from Responses to Chat Completions", async (method) => {
		statuses["/v1/chat/completions"] = 200;
		const backend = provider("gpt-example");
		const result = await backend[method](backend.getModels()[0], context, { apiKey: "secret" }).result();
		expect(paths).toEqual(["/v1/responses", "/v1/chat/completions"]);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it.each([
		["other", ["/v1/chat/completions", "/v1/responses", "/v1/messages"]],
		["gpt-example", ["/v1/responses", "/v1/chat/completions", "/v1/messages"]],
		["claude-example", ["/v1/messages", "/v1/chat/completions", "/v1/responses"]],
	])("tries all protocols before reporting 404 for %s", async (id, expected) => {
		const backend = provider(id);
		const result = await backend.streamSimple(backend.getModels()[0], context, { apiKey: "secret" }).result();
		expect(paths).toEqual(expected);
		expect(result.errorMessage).toContain("HTTP 404 from all three protocols");
		expect(result.errorMessage).toContain(baseUrl);
		expect(result.errorMessage).toContain(id);
	});

	it("succeeds through Messages after both OpenAI endpoints return 404", async () => {
		statuses["/v1/messages"] = 200;
		const backend = provider("other");
		const result = await backend.streamSimple(backend.getModels()[0], context, { apiKey: "secret" }).result();
		expect(paths).toEqual(["/v1/chat/completions", "/v1/responses", "/v1/messages"]);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it.each([400, 401, 403, 429, 500])("does not fall back on HTTP %s", async (status) => {
		statuses["/v1/chat/completions"] = status;
		const backend = provider("other");
		const result = await backend
			.streamSimple(backend.getModels()[0], context, { apiKey: "secret", maxRetries: 0 })
			.result();
		expect(paths).toEqual(["/v1/chat/completions"]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).not.toContain("all three protocols");
	});

	it("keeps normal routing without override fallback", async () => {
		const backend = provider("gpt-example", false);
		await backend.streamSimple(backend.getModels()[0], context, { apiKey: "secret" }).result();
		expect(paths).toEqual(["/v1/responses"]);
	});

	it("does not try other protocols after cancellation", async () => {
		const backend = provider("other");
		const result = await backend
			.streamSimple(backend.getModels()[0], context, { apiKey: "secret", signal: AbortSignal.abort() })
			.result();
		expect(paths).toEqual([]);
		expect(result.stopReason).toBe("aborted");
	});
});
