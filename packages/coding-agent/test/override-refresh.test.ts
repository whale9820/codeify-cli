import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RefreshModelsContext } from "codeify-ai";
import { InMemoryCredentialStore } from "codeify-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toModelDefinition } from "../src/core/codeify-provider.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { type OverrideBackend, OverrideStore, overrideProviderConfig } from "../src/core/overrides.ts";

describe("override backend model refresh", () => {
	let dir: string;
	let server: Server;
	let listed: Array<{ id: string }>;
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

	it("picks up models the backend lists now and persists them", async () => {
		const { path, store, refresh, context } = setup();
		const models = await refresh(context());

		expect(models.map((model) => model.id)).toEqual(["alpha", "beta"]);
		expect(store.get("mine")?.models.map((model) => model.id)).toEqual(["alpha", "beta"]);
		expect(JSON.parse(readFileSync(path, "utf8")).backends[0].models).toHaveLength(2);
		expect(seenAuth).toBe("Bearer secret");
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

	it("keeps existing models when the backend lists none", async () => {
		const { refresh, context } = setup();
		listed = [];
		expect((await refresh(context())).map((model) => model.id)).toEqual(["alpha"]);
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
