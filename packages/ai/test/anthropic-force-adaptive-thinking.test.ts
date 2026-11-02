import { describe, expect, it } from "vitest";
import { getModel, stream, streamSimple } from "../src/compat.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

interface AnthropicThinkingPayload {
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

function makeCustomModel(compat?: Model<"anthropic-messages">["compat"]): Model<"anthropic-messages"> {
	return {
		// Id intentionally does not match any built-in adaptive substring. This
		// mirrors corporate proxy schemes such as `anthropic--claude-opus-latest`.
		id: "vendor--claude-opus-latest",
		name: "Vendor Proxy Opus Latest",
		api: "anthropic-messages",
		provider: "vendor-proxy",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat,
	};
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): Promise<AnthropicThinkingPayload> {
	let capturedPayload: AnthropicThinkingPayload | undefined;

	const payloadCaptureModel: Model<"anthropic-messages"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const s = streamSimple(payloadCaptureModel, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicThinkingPayload;
			throw new PayloadCaptured();
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("Anthropic adaptive thinking", () => {
	it.each([undefined, false, true])("uses adaptive thinking when the compat flag is %s", async (flag) => {
		const payload = await capturePayload(makeCustomModel({ forceAdaptiveThinking: flag }), { reasoning: "medium" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.thinking?.budget_tokens).toBeUndefined();
		expect(payload.output_config).toEqual({ effort: "medium" });
	});

	it.each(["low", "medium", "high", "xhigh", "max"])("preserves %s effort without a model map", async (reasoning) => {
		const payload = await capturePayload(makeCustomModel(), { reasoning });
		expect(payload.output_config).toEqual({ effort: reasoning });
	});

	it("maps the on toggle to a valid effort instead of sending adaptive as an effort", async () => {
		const payload = await capturePayload(
			{ ...makeCustomModel(), thinkingLevelMap: { on: "adaptive" } },
			{ reasoning: "on" },
		);
		expect(payload.thinking?.type).toBe("adaptive");
		expect(payload.output_config).toEqual({ effort: "high" });
	});

	it("allows a direct effort request without thinkingEnabled", async () => {
		let captured: AnthropicThinkingPayload | undefined;
		await stream(makeCustomModel(), makeContext(), {
			apiKey: "fake-key",
			effort: "max",
			onPayload: (payload) => {
				captured = payload as AnthropicThinkingPayload;
				throw new PayloadCaptured();
			},
		}).result();
		expect(captured?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(captured?.output_config).toEqual({ effort: "max" });
	});

	it("sends adaptive thinking payload when compat.forceAdaptiveThinking is true", async () => {
		const payload = await capturePayload(makeCustomModel({ forceAdaptiveThinking: true }), { reasoning: "medium" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "medium" });
	});

	it("uses adaptive thinking with native xhigh effort for Claude Fable 5", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5"), { reasoning: "xhigh" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "xhigh" });
	});

	it("preserves thinking.type=disabled when reasoning is off regardless of override", async () => {
		const payload = await capturePayload(makeCustomModel({ forceAdaptiveThinking: true }));

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});
});
