import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { CODEIFY_BASE_URL } from "../src/core/codeify-provider.ts";

describe("Codeify-only CLI runtime", () => {
	it("ignores custom providers while retaining the Codeify model cache", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "codeify-only-runtime-"));
		try {
			writeFileSync(
				join(agentDir, "models.json"),
				JSON.stringify({
					providers: {
						custom: {
							name: "Custom",
							baseUrl: "https://custom.example/v1",
							apiKey: "custom-key",
							api: "openai-responses",
							models: [{ id: "custom-model" }],
						},
					},
				}),
			);
			writeFileSync(
				join(agentDir, "models-store.json"),
				JSON.stringify({
					codeify: {
						models: [
							{
								id: "cached-codeify-model",
								name: "Cached Codeify Model",
								provider: "codeify",
								baseUrl: CODEIFY_BASE_URL,
								api: "openai-responses",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128_000,
								maxTokens: 16_384,
							},
						],
						checkedAt: Date.now(),
					},
				}),
			);

			const services = await createAgentSessionServices({
				cwd: agentDir,
				agentDir,
				includeBuiltinProviders: false,
				resourceLoaderOptions: {
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
				},
			});

			expect(services.modelRuntime.getProviders().map((provider) => provider.id)).toEqual(["codeify"]);
			expect(services.modelRuntime.getModel("custom", "custom-model")).toBeUndefined();
			expect(services.modelRuntime.getModel("codeify", "cached-codeify-model")).toBeDefined();
			expect(services.modelRuntime.getModels().every((model) => model.provider === "codeify")).toBe(true);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
