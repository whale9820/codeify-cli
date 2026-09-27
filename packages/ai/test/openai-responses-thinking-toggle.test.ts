import { afterEach, describe, expect, it, vi } from "vitest";
import { stream, streamSimple } from "../src/api/openai-responses.ts";
import type { Model } from "../src/types.ts";

const toggleOnlyModel: Model<"openai-responses"> = {
	id: "toggle-empty",
	name: "toggle-empty",
	provider: "codeify",
	api: "openai-responses",
	baseUrl: "https://codeify.cc/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
	thinkingLevelMap: {
		off: "disabled",
		on: "adaptive",
		minimal: null,
		low: null,
		medium: null,
		high: null,
		xhigh: null,
		max: null,
	},
};

const toggleEffortModel: Model<"openai-responses"> = {
	...toggleOnlyModel,
	id: "toggle-efforts",
	name: "toggle-efforts",
	thinkingLevelMap: {
		off: "disabled",
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: null,
	},
};

function emptySse(): Response {
	return new Response("data: [DONE]\n\n", {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function captureBody(
	model: Model<"openai-responses">,
	options: Parameters<typeof stream>[2] | Parameters<typeof streamSimple>[2],
	mode: "stream" | "simple" = "stream",
): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> | undefined;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return emptySse();
	});

	const response =
		mode === "simple"
			? streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, options)
			: stream(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, options);
	for await (const event of response) {
		if (event.type === "done" || event.type === "error") break;
	}
	if (!body) throw new Error("request body was not captured");
	return body;
}

describe("Codeify thinking toggle payloads", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends adaptive thinking when on is selected", async () => {
		const body = await captureBody(toggleOnlyModel, { apiKey: "test-key", reasoningEffort: "on" });
		expect(body.thinking).toEqual({ type: "adaptive" });
		expect(body).not.toHaveProperty("reasoning");
	});

	it("sends disabled thinking when off is selected", async () => {
		const body = await captureBody(toggleOnlyModel, { apiKey: "test-key" });
		expect(body.thinking).toEqual({ type: "disabled" });
		expect(body).not.toHaveProperty("reasoning");
	});

	it("sends adaptive thinking from streamSimple on", async () => {
		const body = await captureBody(toggleOnlyModel, { apiKey: "test-key", reasoning: "on" }, "simple");
		expect(body.thinking).toEqual({ type: "adaptive" });
		expect(body).not.toHaveProperty("reasoning");
	});

	it("sends disabled thinking from streamSimple off", async () => {
		const body = await captureBody(toggleOnlyModel, { apiKey: "test-key" }, "simple");
		expect(body.thinking).toEqual({ type: "disabled" });
		expect(body).not.toHaveProperty("reasoning");
	});

	it("keeps reasoning effort when a thinking modality is selected", async () => {
		const body = await captureBody(toggleEffortModel, { apiKey: "test-key", reasoningEffort: "medium" });
		expect(body.reasoning).toEqual({ effort: "medium", summary: "auto" });
		expect(body).not.toHaveProperty("thinking");
	});

	it("sends disabled thinking for off even when modalities exist", async () => {
		const body = await captureBody(toggleEffortModel, { apiKey: "test-key" });
		expect(body.thinking).toEqual({ type: "disabled" });
		expect(body).not.toHaveProperty("reasoning");
	});
});
