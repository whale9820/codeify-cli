import { describe, expect, it } from "vitest";
import { apiForModelId, routeModels, toModelDefinition } from "../src/core/codeify-provider.ts";

describe("model routing", () => {
	it("picks the api from the model name", () => {
		expect(apiForModelId("claude-opus-5-5")).toBe("anthropic-messages");
		expect(apiForModelId("GLM-4.6")).toBe("anthropic-messages");
		expect(apiForModelId("glm5")).toBe("anthropic-messages");
		expect(apiForModelId("qwen3.8-max")).toBe("openai-responses");
		expect(apiForModelId("Qwen3.8-Flash")).toBe("openai-responses");
		expect(apiForModelId("qwen3-coder-next")).toBe("openai-responses");
		expect(apiForModelId("qwen-max")).toBe("openai-responses");
		expect(apiForModelId("gpt-5-mini")).toBe("openai-responses");
		expect(apiForModelId("openai/gpt-6.2-astra")).toBe("openai-responses");
		expect(apiForModelId("openai/gpt-6-astra:batch")).toBe("openai-responses");
		expect(apiForModelId("anthropic/claude-opus-5")).toBe("anthropic-messages");
		expect(apiForModelId("meta/llama-3")).toBe("openai-completions");
		expect(apiForModelId("llama-3")).toBe("openai-completions");
		expect(apiForModelId("grok-4.5")).toBe("openai-responses");
		expect(apiForModelId("grok-4.3")).toBe("openai-responses");
		expect(apiForModelId("xai/grok-4.6")).toBe("openai-responses");
		expect(apiForModelId("Grok-Build-0.1")).toBe("openai-responses");
	});

	it("strips the trailing /v1 for anthropic models only", () => {
		const models = ["claude-sonnet-5-5", "gpt-5", "llama-3"].map((id) => toModelDefinition({ id }));
		const routed = routeModels(models, "https://example.com/v1");

		expect(routed[0]).toMatchObject({ api: "anthropic-messages", baseUrl: "https://example.com" });
		expect(routed[1].api).toBe("openai-responses");
		expect(routed[1].baseUrl).toBeUndefined();
		expect(routed[2].api).toBe("openai-completions");
		expect(routed[2].baseUrl).toBeUndefined();
	});

	it("routes namespaced OpenAI IDs through Responses and strips /v1 only for Anthropic", () => {
		const models = ["openai/gpt-6.2-astra", "anthropic/claude-opus-5"].map((id) => toModelDefinition({ id }));
		const routed = routeModels(models, "https://example.com/v1");

		expect(routed[0]).toMatchObject({ id: "openai/gpt-6.2-astra", api: "openai-responses" });
		expect(routed[0].baseUrl).toBeUndefined();
		expect(routed[1]).toMatchObject({ api: "anthropic-messages", baseUrl: "https://example.com" });
	});

	it("routes Qwen through Responses so hosted search is declared", () => {
		const [model] = routeModels([toModelDefinition({ id: "qwen3.8-max" })], "https://codeify.cc/v1");
		expect(model).toMatchObject({ id: "qwen3.8-max", api: "openai-responses" });
		expect(model.baseUrl).toBeUndefined();
	});

	it("routes grok models through Responses", () => {
		const models = ["grok-4.3", "xai/grok-4.6"].map((id) => toModelDefinition({ id }));
		const routed = routeModels(models, "https://codeify.cc/v1");
		expect(routed[0]).toMatchObject({ id: "grok-4.3", api: "openai-responses" });
		expect(routed[0].baseUrl).toBeUndefined();
		expect(routed[1]).toMatchObject({ id: "xai/grok-4.6", api: "openai-responses" });
		expect(routed[1].baseUrl).toBeUndefined();
	});
});
