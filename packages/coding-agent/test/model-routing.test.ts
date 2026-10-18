import { describe, expect, it } from "vitest";
import { apiForModelId, routeModels, toModelDefinition } from "../src/core/codeify-provider.ts";

describe("model routing", () => {
	it("picks the api from the model name", () => {
		expect(apiForModelId("claude-opus-5-5")).toBe("anthropic-messages");
		expect(apiForModelId("GLM-4.6")).toBe("anthropic-messages");
		expect(apiForModelId("qwen3.8-max")).toBe("anthropic-messages");
		expect(apiForModelId("Qwen3.8-Flash")).toBe("anthropic-messages");
		expect(apiForModelId("gpt-5-mini")).toBe("openai-responses");
		expect(apiForModelId("llama-3")).toBe("openai-completions");
	});

	it("strips the trailing /v1 for anthropic models only", () => {
		const models = ["claude-sonnet-5-5", "gpt-5", "qwen3"].map((id) => toModelDefinition({ id }));
		const routed = routeModels(models, "https://example.com/v1");

		expect(routed[0]).toMatchObject({ api: "anthropic-messages", baseUrl: "https://example.com" });
		expect(routed[1].api).toBe("openai-responses");
		expect(routed[1].baseUrl).toBeUndefined();
		expect(routed[2].api).toBe("openai-completions");
		expect(routed[2].baseUrl).toBeUndefined();
	});

	it("routes Qwen 3.8 through Messages so hosted search is declared", () => {
		const [model] = routeModels([toModelDefinition({ id: "qwen3.8-max" })], "https://codeify.cc/v1");
		expect(model).toMatchObject({ id: "qwen3.8-max", api: "anthropic-messages", baseUrl: "https://codeify.cc" });
	});
});
