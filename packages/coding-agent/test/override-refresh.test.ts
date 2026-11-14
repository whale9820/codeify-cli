import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RefreshModelsContext } from "codeify-ai";
import { InMemoryCredentialStore } from "codeify-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CodeifyModel, routeModels, toModelDefinition } from "../src/core/codeify-provider.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import {
	inheritCodeifyMetadata,
	type OverrideBackend,
	OverrideStore,
	overrideProviderConfig,
} from "../src/core/overrides.ts";
import { formatUsageReport } from "../src/modes/interactive/usage-report.ts";

describe("override backend model refresh", () => {
	let dir: string;
	let server: Server;
	let listed: CodeifyModel[];
	let status: number;
	let seenAuth: string | undefined;
	let baseUrl: string;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "override-refresh-"));
		listed = [{ id: "alpha" }, { id: "beta" }];
		status = 200;
		seenAuth = undefined;
		server = createServer((request, response) => {
			seenAuth = request.headers.authorization;
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify({ data: listed }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	});

	afterEach(() => {
		server.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function setup() {
		const path = join(dir, "overrides.json");
		const store = new OverrideStore(path);
		const backend: OverrideBackend = {
			name: "mine",
			baseUrl,
			apiKey: "secret",
			models: [toModelDefinition({ id: "alpha" })],
		};
		store.upsert(backend);
		const refresh = overrideProviderConfig(backend, store).refreshModels!;
		const context = (allowNetwork = true) => ({ allowNetwork }) as unknown as RefreshModelsContext;
		return { path, store, refresh, context };
	}

	it("inherits Codeify metadata from namespaced and dated API model IDs", () => {
		const models = [
			toModelDefinition({ id: "zai-org/GLM-5.3-Flash" }),
			toModelDefinition({ id: "deepseek-ai/DeepSeek-V4-Flash-0731" }),
		];
		const codeifyModels = routeModels(
			[
				toModelDefinition({ id: "glm-5.3-flash", reasoning: true, context: 200_000 }),
				toModelDefinition({ id: "deepseek-v4-flash-0731", reasoning: true, context: 300_000 }),
			],
			baseUrl,
		);

		const inherited = inheritCodeifyMetadata(models, codeifyModels);

		expect(inherited.map((model) => model.id)).toEqual(models.map((model) => model.id));
		expect(inherited[0]).toMatchObject({ reasoning: true, contextWindow: 200_000 });
		expect(inherited[1]).toMatchObject({ reasoning: true, contextWindow: 300_000 });
	});

	it("uses the undated Codeify model when a dated API model has no exact catalog entry", () => {
		const apiModel = toModelDefinition({ id: "deepseek-ai/DeepSeek-V4-Flash-0731" });
		const codeifyModels = routeModels([toModelDefinition({ id: "deepseek-v4-flash", reasoning: true })], baseUrl);

		expect(inheritCodeifyMetadata([apiModel], codeifyModels)[0]).toMatchObject({ reasoning: true });
	});

	it("preserves declared context and does not inherit a generic fallback", () => {
		const models = [
			toModelDefinition({ id: "openai/gpt-6.2-astra", context: 272_000 }),
			toModelDefinition({ id: "unknown-context-model" }),
		];
		const codeifyModels = routeModels(
			[toModelDefinition({ id: "gpt-6.2-astra" }), toModelDefinition({ id: "unknown-context-model" })],
			baseUrl,
		);

		expect(inheritCodeifyMetadata(models, codeifyModels).map((model) => model.contextWindow)).toEqual([
			272_000,
			null,
		]);
	});

	it("picks up models the backend lists now and persists them", async () => {
		const { path, store, refresh, context } = setup();
		const models = await refresh(context());

		expect(models.map((model) => model.id)).toEqual(["alpha", "beta"]);
		expect(store.get("mine")?.models.map((model) => model.id)).toEqual(["alpha", "beta"]);
		expect(JSON.parse(readFileSync(path, "utf8")).backends[0].models).toHaveLength(2);
		expect(seenAuth).toBe("Bearer secret");
	});

	it("fills missing limits for newly listed models from the backend catalog", async () => {
		const { refresh, context } = setup();
		listed = [
			{ id: "gpt-6.2-astra", max_output_tokens: 64_000 },
			{ id: "gpt-6-astra", context: 720_000, max_tokens: 128_000 },
		];

		const models = await refresh(context());

		expect(models[0]).toMatchObject({ id: "gpt-6.2-astra", contextWindow: 720_000, maxTokens: 64_000 });
	});

	it("infers context from null limits on startup and refresh without persisting a fallback", async () => {
		const { path, store, refresh, context } = setup();
		const id = "openai/gpt-6.2-astra";
		const backend = store.get("mine")!;
		store.upsert({
			...backend,
			models: [toModelDefinition({ id, max_tokens: 64_000 })],
		});

		const [offline] = await refresh(context(false));
		expect(offline).toMatchObject({ id, contextWindow: 1_050_000, maxTokens: 64_000 });
		expect(
			formatUsageReport({
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextUsage: { tokens: 31_100, contextWindow: offline.contextWindow },
			}),
		).toContain("31.1k/1.1m context");

		listed = [
			{ id, context: null },
			{ id: "openai/gpt-6-astra", context: 720_000 },
		];
		const [refreshed] = await refresh(context());
		expect(refreshed).toMatchObject({ id, contextWindow: 720_000, maxTokens: 64_000 });
		const reloaded = new OverrideStore(path).get("mine")!;
		expect(reloaded.models[0].contextWindow).toBeNull();
		expect(overrideProviderConfig(reloaded).models?.[0].contextWindow).toBe(720_000);
	});

	it("replaces a legacy cached context only after the backend reports the current declaration", async () => {
		const { store, refresh, context } = setup();
		const id = "gpt-6.2-astra";
		store.upsert({ ...store.get("mine")!, models: [toModelDefinition({ id, context: 272_000 })] });
		expect((await refresh(context(false)))[0].contextWindow).toBe(272_000);

		listed = [{ id, context: 272_000 }];
		expect((await refresh(context()))[0].contextWindow).toBe(272_000);

		listed = [{ id }];
		expect((await refresh(context()))[0].contextWindow).toBe(1_050_000);
		expect(store.get("mine")?.models[0].contextWindow).toBeNull();
	});

	it("drops models the backend no longer lists", async () => {
		const { refresh, context } = setup();
		listed = [{ id: "gamma" }];
		expect((await refresh(context())).map((model) => model.id)).toEqual(["gamma"]);
	});

	it("reports a failing backend instead of silently succeeding", async () => {
		const { store, refresh, context } = setup();
		status = 500;
		await expect(refresh(context())).rejects.toThrow(/Could not refresh mine/);
		expect(store.get("mine")?.models.map((model) => model.id)).toEqual(["alpha"]);
	});

	it("clears the model list when the backend lists none", async () => {
		const { store, refresh, context } = setup();
		listed = [];
		expect(await refresh(context())).toEqual([]);
		expect(store.get("mine")?.models).toEqual([]);
	});

	it("does not touch the network when offline", async () => {
		const { refresh, context } = setup();
		await refresh(context(false));
		expect(seenAuth).toBeUndefined();
	});

	it("refreshes through ModelRuntime so the model list and errors reach the /model selector", async () => {
		const overridesPath = join(dir, "runtime-overrides.json");
		const seed = new OverrideStore(overridesPath);
		seed.upsert({ name: "mine", baseUrl, apiKey: "secret", models: [toModelDefinition({ id: "alpha" })] });

		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			overridesPath,
			allowModelNetwork: false,
		});
		runtime.unregisterProvider("codeify");
		const ids = () =>
			runtime
				.getModels()
				.filter((model) => model.provider === "override-mine")
				.map((model) => model.id);
		expect(ids()).toEqual(["alpha"]);

		const ok = await runtime.refresh({ allowNetwork: true });
		expect(ok.errors.size).toBe(0);
		expect(ids()).toEqual(["alpha", "beta"]);

		status = 500;
		const failed = await runtime.refresh({ allowNetwork: true });
		expect(failed.errors.has("override-mine")).toBe(true);
		expect(ids()).toEqual(["alpha", "beta"]);
	});
});
