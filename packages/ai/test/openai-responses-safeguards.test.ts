import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { isSafeguardBlock } from "../src/utils/retry.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-5-mini",
	name: "GPT-5 Mini",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

function createOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
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
}

async function* events(list: unknown[]): AsyncIterable<ResponseStreamEvent> {
	for (const event of list) yield event as ResponseStreamEvent;
}

async function run(list: unknown[]): Promise<Error> {
	try {
		await processResponsesStream(events(list), createOutput(), new AssistantMessageEventStream(), model);
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected processResponsesStream to throw");
}

describe("OpenAI Responses safeguard blocks", () => {
	it("flags a refusal stream", async () => {
		const error = await run([
			{
				type: "response.refusal.delta",
				sequence_number: 0,
				output_index: 0,
				content_index: 0,
				item_id: "m",
				delta: "I can't help",
			},
			{ type: "response.completed", sequence_number: 1, response: { id: "r", status: "completed" } },
		]);
		expect(isSafeguardBlock(error.message)).toBe(true);
	});

	it("flags a content_filter incomplete response", async () => {
		const error = await run([
			{
				type: "response.incomplete",
				sequence_number: 0,
				response: { id: "r", status: "incomplete", incomplete_details: { reason: "content_filter" } },
			},
		]);
		expect(isSafeguardBlock(error.message)).toBe(true);
	});

	it("flags a policy failure but not a plain server error", async () => {
		const policy = await run([
			{
				type: "response.failed",
				sequence_number: 0,
				response: {
					id: "r",
					status: "failed",
					error: { code: "invalid_prompt", message: "flagged for potential cybersecurity risk" },
				},
			},
		]);
		expect(isSafeguardBlock(policy.message)).toBe(true);

		const plain = await run([
			{
				type: "response.failed",
				sequence_number: 0,
				response: { id: "r", status: "failed", error: { code: "server_error", message: "boom" } },
			},
		]);
		expect(isSafeguardBlock(plain.message)).toBe(false);
	});
});
