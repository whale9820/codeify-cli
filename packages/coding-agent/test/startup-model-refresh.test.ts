import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore, type Model } from "codeify-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CODEIFY_BASE_URL } from "../src/core/codeify-provider.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const cachedModel: Model<"openai-completions"> = {
	id: "cached-model",
	name: "cached-model",
	provider: "codeify",
	api: "openai-completions",
	baseUrl: CODEIFY_BASE_URL,
	reasoning: true,
	thinkingLevelMap: { off: null, low: "low", high: "high", xhigh: null, max: null },
	input: ["text", "image"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
};

const resourceLoaderOptions = {
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
};

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codeify-startup-refresh-"));
	vi.stubEnv("CODEIFY_OFFLINE", undefined);
	vi.stubEnv("CODEIFY_API_KEY", undefined);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

async function createRuntime(cached = true): Promise<ModelRuntime> {
	const modelsStore = new InMemoryModelsStore();
	if (cached) {
		await modelsStore.write("codeify", { models: [cachedModel], checkedAt: 0 });
	}
	return ModelRuntime.create({
		credentials: AuthStorage.inMemory({ codeify: { type: "api_key", key: "test-key" } }),
		modelsPath: null,
		modelsStore,
		includeBuiltinProviders: false,
	});
}

function createServices(modelRuntime: ModelRuntime, allowNetwork?: boolean) {
	return createAgentSessionServices({
		cwd: directory,
		agentDir: directory,
		modelRuntime,
		allowNetwork,
		resourceLoaderOptions,
	});
}

describe("startup model catalog refresh", () => {
	it("returns cached models and capabilities without contacting the network", async () => {
		const services = await createServices(await createRuntime(), false);

		expect(fetch).not.toHaveBeenCalled();
		expect(services.modelRuntime.getModel("codeify", cachedModel.id)).toMatchObject(cachedModel);
		expect(services.modelRuntime.getAvailableSnapshot().map((model) => model.id)).toEqual([cachedModel.id]);
		expect(services.diagnostics).toEqual([]);
	});

	it("keeps startup usable while a subsequent background refresh is pending", async () => {
		const runtime = await createRuntime();
		const services = await createServices(runtime, false);
		let release: () => void = () => {};
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.mocked(fetch).mockImplementation(async () => {
			await pending;
			return new Response(JSON.stringify({ data: [{ id: "from-network" }] }));
		});

		const refresh = runtime.refresh({ allowNetwork: true, force: true });
		try {
			await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
			expect(services.modelRuntime.getModel("codeify", cachedModel.id)).toMatchObject(cachedModel);
		} finally {
			release();
			await refresh;
		}
		expect(runtime.getModel("codeify", "from-network")).toBeDefined();
	});

	it("starts without a populated cache and does not wait on discovery", async () => {
		const services = await createServices(await createRuntime(false), false);

		expect(fetch).not.toHaveBeenCalled();
		expect(services.modelRuntime.getAvailableSnapshot().length).toBeGreaterThan(0);
	});

	it.each([true, undefined])("refreshes the live catalog for blocking callers (%s)", async (allowNetwork) => {
		vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "from-network" }] })));
		const services = await createServices(await createRuntime(), allowNetwork);

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledWith(`${CODEIFY_BASE_URL}/models`, expect.any(Object));
		expect(services.modelRuntime.getModel("codeify", "from-network")).toBeDefined();
	});

	it("honors offline mode even when the caller requests a network refresh", async () => {
		vi.stubEnv("CODEIFY_OFFLINE", "1");
		const services = await createServices(await createRuntime(), true);

		expect(fetch).not.toHaveBeenCalled();
		expect(services.modelRuntime.getModel("codeify", cachedModel.id)).toMatchObject(cachedModel);
	});

	it("preserves cached models when the background request fails", async () => {
		const runtime = await createRuntime();
		await createServices(runtime, false);
		await runtime.refresh({ allowNetwork: true, force: true });

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(runtime.getModel("codeify", cachedModel.id)).toMatchObject(cachedModel);
	});

	it("reports refresh errors returned by the model runtime", async () => {
		const services = await createServices(await createRuntime(false), true);

		expect(services.diagnostics).toEqual([
			expect.objectContaining({ type: "warning", message: expect.stringContaining("Unexpected network request") }),
		]);
	});
});
