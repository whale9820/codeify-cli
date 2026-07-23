import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore, type Model, type Provider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

function model(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "oauth-provider",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

describe("runtime provider model lifecycle", () => {
	it("registers native pi-ai providers with their auth implementation", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const nativeModel = {
			...model("native"),
			provider: "native-provider",
			baseUrl: "https://fallback.test/v1",
		};
		const provider: Provider = {
			id: "native-provider",
			name: "Native provider",
			auth: {
				apiKey: {
					name: "Native setup",
					login: async (interaction) => ({
						type: "api_key",
						key: await interaction.prompt({ type: "secret", message: "API key" }),
					}),
					check: async ({ credential }) =>
						credential?.key ? { type: "api_key", source: "stored native key" } : undefined,
					resolve: async ({ credential }) =>
						credential?.key
							? {
									auth: { apiKey: credential.key, baseUrl: "https://resolved.test/v1" },
									source: "stored native key",
								}
							: undefined,
				},
			},
			getModels: () => [nativeModel],
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
		};

		runtime.registerNativeProvider(provider);
		const registry = new ModelRegistry(runtime);
		expect(registry.getProvider("native-provider")).toBe(provider);
		expect(registry.getRegisteredNativeProvider("native-provider")).toBe(provider);
		expect(registry.getRegisteredProviderIds()).toContain("native-provider");
		expect(registry.find("native-provider", "native")).toBeDefined();

		await runtime.login("native-provider", "api_key", {
			prompt: async () => "secret",
			notify: () => {},
		});
		expect(await registry.getProviderAuth("native-provider")).toMatchObject({
			auth: { apiKey: "secret", baseUrl: "https://resolved.test/v1" },
		});

		registry.unregisterProvider("native-provider");
		expect(registry.getProvider("native-provider")).toBeUndefined();
	});

	it("applies models.json overrides above native providers", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-native-provider-"));
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"native-provider": {
						modelOverrides: {
							native: { contextWindow: 4242 },
						},
					},
				},
			}),
		);
		try {
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsStore: new InMemoryModelsStore(),
				modelsPath,
				allowModelNetwork: false,
			});
			const nativeModel = {
				...model("native"),
				provider: "native-provider",
				baseUrl: "https://native.test/v1",
			};
			runtime.registerNativeProvider({
				id: "native-provider",
				name: "Native provider",
				auth: {
					apiKey: {
						name: "Native key",
						resolve: async () => ({ auth: { apiKey: "key" }, source: "native" }),
					},
				},
				getModels: () => [nativeModel],
				stream: () => {
					throw new Error("unused");
				},
				streamSimple: () => {
					throw new Error("unused");
				},
			});

			expect(runtime.getModel("native-provider", "native")?.contextWindow).toBe(4242);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("publishes refreshModels results without forcing ModelsStore persistence", async () => {
		const modelsStore = new InMemoryModelsStore();
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore,
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerProvider("dynamic-provider", {
			baseUrl: "http://localhost:8080/v1",
			apiKey: "local",
			api: "openai-completions",
			refreshModels: async () => [
				{
					...model("live"),
					provider: "dynamic-provider",
					baseUrl: "http://localhost:8080/v1",
				},
			],
		});

		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getModel("dynamic-provider", "live")).toBeDefined();
		expect(await modelsStore.read("dynamic-provider")).toBeUndefined();
	});

	it("applies legacy OAuth modifyModels after async credential initialization", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				"oauth-provider": {
					type: "oauth",
					access: "access",
					refresh: "refresh",
					expires: Date.now() + 60_000,
				},
			}),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerProvider("oauth-provider", {
			baseUrl: "https://example.test/v1",
			api: "openai-completions",
			models: [model("base")],
			oauth: {
				name: "Provider OAuth",
				login: async () => {
					throw new Error("not used");
				},
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
				modifyModels: (models, credential) =>
					credential.access === "access" ? [...models, model("credential-model")] : models,
			},
		});

		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getModel("oauth-provider", "base")).toBeDefined();
		expect(runtime.getModel("oauth-provider", "credential-model")).toBeDefined();

		await runtime.logout("oauth-provider");
		expect(runtime.getModel("oauth-provider", "credential-model")).toBeUndefined();
	});
});
