import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function createModel(): Model<"openai-responses"> {
	return {
		id: "minimal-provider-model",
		name: "Minimal Provider Model",
		api: "openai-responses",
		provider: "codeify",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	};
}

function createOutput(model: Model<"openai-responses">): AssistantMessage {
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

/** created -> output_text.delta -> completed, with no output_item.added in between. */
async function* deltaWithoutItemAdded(): AsyncIterable<ResponseStreamEvent> {
	yield { type: "response.created", sequence_number: 0, response: { id: "resp_minimal" } } as ResponseStreamEvent;
	yield {
		type: "response.output_text.delta",
		sequence_number: 1,
		output_index: 0,
		content_index: 0,
		item_id: "msg_minimal",
		delta: "ok",
	} as ResponseStreamEvent;
	yield {
		type: "response.completed",
		sequence_number: 2,
		response: { id: "resp_minimal", status: "completed" },
	} as unknown as ResponseStreamEvent;
}

/** Text present only in the terminal response payload, with no delta events at all. */
async function* textOnlyInTerminalResponse(): AsyncIterable<ResponseStreamEvent> {
	yield { type: "response.created", sequence_number: 0, response: { id: "resp_terminal" } } as ResponseStreamEvent;
	yield {
		type: "response.completed",
		sequence_number: 1,
		response: {
			id: "resp_terminal",
			status: "completed",
			output: [
				{
					type: "message",
					id: "msg_terminal",
					role: "assistant",
					content: [{ type: "output_text", text: "recovered text", annotations: [] }],
				},
			],
		},
	} as unknown as ResponseStreamEvent;
}

describe("OpenAI Responses minimal provider streams", () => {
	it("keeps text streamed without a preceding output_item.added event", async () => {
		const model = createModel();
		const output = createOutput(model);

		await processResponsesStream(deltaWithoutItemAdded(), output, new AssistantMessageEventStream(), model);

		expect(output.content).toEqual([{ type: "text", text: "ok" }]);
		expect(output.stopReason).toBe("stop");
	});

	it("recovers text reported only in the terminal response", async () => {
		const model = createModel();
		const output = createOutput(model);

		await processResponsesStream(textOnlyInTerminalResponse(), output, new AssistantMessageEventStream(), model);

		expect(output.content).toEqual([{ type: "text", text: "recovered text" }]);
	});
});
