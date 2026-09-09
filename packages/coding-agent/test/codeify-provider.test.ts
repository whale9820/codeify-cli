import { createHash } from "node:crypto";
import type { ModelsStoreEntry, OAuthLoginCallbacks } from "codeify-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEIFY_BASE_URL, codeifyProvider, loginWithCodeifyOAuth } from "../src/core/codeify-provider.ts";
import { openBrowser } from "../src/utils/open-browser.ts";

vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function oauthCallbacks(onAuth: (url: URL) => void): OAuthLoginCallbacks {
	return {
		onAuth: ({ url }) => onAuth(new URL(url)),
		onDeviceCode: () => {},
		onPrompt: async () => "",
		onProgress: () => {},
		onManualCodeInput: async () => "",
		onSelect: async () => undefined,
		signal: undefined,
	};
}

describe("Codeify provider", () => {
	it("defaults to GPT-6 Astra with extra-high reasoning support", () => {
		const provider = codeifyProvider();
		const model = provider.models?.find((candidate) => candidate.id === "gpt-6-astra");

		expect(provider).toMatchObject({ name: "Codeify", oauth: { name: "Codeify" } });
		expect(model).toMatchObject({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } });
	});

	it("uses only Codeify model metadata", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					data: [
						{
							id: "gpt-5.6-sol",
							context: 1_050_000,
							max_tokens: 128_000,
							capabilities: { reasoning: true },
							input_modalities: ["text", "image"],
							pricing: { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 },
						},
					],
				}),
				{ status: 200 },
			),
		);
		const models = await codeifyProvider().refreshModels?.({
			credential: { type: "api_key", key: "test-key" },
			store: { read: async () => undefined, write: async () => {}, delete: async () => {} },
			allowNetwork: true,
			force: true,
		});

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(models?.[0]).toMatchObject({
			id: "gpt-5.6-sol",
			name: "gpt-5.6-sol",
			contextWindow: 1_050_000,
			maxTokens: 128_000,
			cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
			input: ["text", "image"],
		});
	});

	it("uses Codeify v1 model metadata and pricing", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url === `${CODEIFY_BASE_URL}/models`) {
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "gpt-5.6-sol",
								context: 400_000,
								max_tokens: 64_000,
								capabilities: { reasoning: false },
								pricing: {
									input: 1,
									output: 4,
									cache_read: 0.1,
									cache_write: 0.2,
									unit: "usd_per_million_tokens",
								},
							},
						],
					}),
					{ status: 200 },
				);
			}
			return new Response(
				JSON.stringify({
					"gpt-5.6-sol": {
						id: "gpt-5.6-sol",
						name: "GPT-5.6 Sol",
						contextWindow: 1_050_000,
						maxTokens: 128_000,
						reasoning: true,
						cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
					},
				}),
				{ status: 200 },
			);
		});
		const provider = codeifyProvider();
		const models = await provider.refreshModels?.({
			credential: { type: "api_key", key: "test-key" },
			store: { read: async () => undefined, write: async () => {}, delete: async () => {} },
			allowNetwork: true,
			force: true,
		});

		expect(models?.[0]).toMatchObject({
			name: "gpt-5.6-sol",
			reasoning: false,
			contextWindow: 1_050_000,
			maxTokens: 64_000,
			cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0.2 },
		});
	});

	it("raises GPT-5.5 and every GPT-5.6 variant in live and cached catalogs", async () => {
		const ids = [
			"gpt-5.5",
			"gpt-5.5-pro",
			"gpt-5.6",
			"gpt-5.6-luna",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-sol-uncensored",
		];
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					data: [
						...ids.map((id) => ({ id, context: 272_000, name: "Ignored display name" })),
						{ id: "gpt-5.4", context: 272_000 },
					],
				}),
			),
		);
		let stored: ModelsStoreEntry | undefined;
		const store = {
			read: async () => stored,
			write: async (entry: ModelsStoreEntry) => {
				stored = entry;
			},
			delete: async () => {},
		};
		const live = await codeifyProvider().refreshModels!({
			credential: { type: "api_key", key: "test" },
			store,
			allowNetwork: true,
		});
		stored = { models: stored!.models.map((model) => ({ ...model, contextWindow: 272_000 })) };
		const cached = await codeifyProvider().refreshModels!({ credential: undefined, store, allowNetwork: false });
		for (const models of [live, cached]) {
			for (const id of ids)
				expect(models.find((model) => model.id === id)).toMatchObject({ name: id, contextWindow: 1_050_000 });
			expect(models.find((model) => model.id === "gpt-5.4")?.contextWindow).toBe(272_000);
		}
	});

	it("recognizes GPT-6 models as reasoning models without catalog metadata", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			if (String(input) === `${CODEIFY_BASE_URL}/models`) {
				return new Response(JSON.stringify({ data: [{ id: "gpt-6-astra" }] }), { status: 200 });
			}
			throw new Error("remote catalog unavailable");
		});
		const models = await codeifyProvider().refreshModels?.({
			credential: { type: "api_key", key: "test-key" },
			store: { read: async () => undefined, write: async () => {}, delete: async () => {} },
			allowNetwork: true,
			force: true,
		});

		expect(models?.[0]).toMatchObject({
			id: "gpt-6-astra",
			reasoning: true,
			thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
		});
	});

	it("re-derives GPT-6 reasoning support from a stale cache", async () => {
		const models = await codeifyProvider().refreshModels?.({
			credential: undefined,
			store: {
				read: async () => ({
					models: [
						{
							id: "gpt-6-astra",
							name: "gpt-6-astra",
							provider: "codeify",
							baseUrl: CODEIFY_BASE_URL,
							api: "openai-responses",
							reasoning: false,
							thinkingLevelMap: { off: null },
							input: ["text"],
							cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
							contextWindow: 1_050_000,
							maxTokens: 32_768,
						},
					],
					checkedAt: Date.now(),
				}),
				write: async () => {},
				delete: async () => {},
			},
			allowNetwork: false,
		});

		expect(models?.[0]).toMatchObject({
			id: "gpt-6-astra",
			reasoning: true,
			thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
		});
	});

	it("preserves explicitly declared non-reasoning GPT-6 models", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			if (String(input) === `${CODEIFY_BASE_URL}/models`) {
				return new Response(
					JSON.stringify({ data: [{ id: "gpt-6-instant", capabilities: { reasoning: false } }] }),
					{ status: 200 },
				);
			}
			throw new Error("remote catalog unavailable");
		});
		const models = await codeifyProvider().refreshModels?.({
			credential: { type: "api_key", key: "test-key" },
			store: { read: async () => undefined, write: async () => {}, delete: async () => {} },
			allowNetwork: true,
			force: true,
		});

		expect(models?.[0]).toMatchObject({
			id: "gpt-6-instant",
			reasoning: false,
			thinkingLevelMap: { off: null },
		});
	});

	it("restores the cached Codeify catalog without network access", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const provider = codeifyProvider();
		const models = await provider.refreshModels?.({
			credential: undefined,
			store: {
				read: async () => ({
					models: [
						{
							id: "gpt-5.6-sol",
							name: "GPT-5.6 Sol",
							provider: "codeify",
							baseUrl: CODEIFY_BASE_URL,
							api: "openai-responses",
							reasoning: true,
							input: ["text", "image"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1_050_000,
							maxTokens: 128_000,
						},
					],
					checkedAt: Date.now(),
				}),
				write: async () => {},
				delete: async () => {},
			},
			allowNetwork: false,
		});

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(models?.[0]).toMatchObject({ contextWindow: 1_050_000, maxTokens: 128_000 });
	});

	it("fetches Codeify models once on every provider startup even with a fresh cache", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url === `${CODEIFY_BASE_URL}/models`) {
				return new Response(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }), { status: 200 });
			}
			return new Response(
				JSON.stringify({
					"gpt-5.6-sol": {
						id: "gpt-5.6-sol",
						contextWindow: 1_050_000,
						maxTokens: 128_000,
					},
				}),
				{ status: 200 },
			);
		});
		let stored = {
			models: [
				{
					id: "gpt-5.6-sol",
					name: "GPT-5.6 Sol",
					provider: "codeify",
					baseUrl: CODEIFY_BASE_URL,
					api: "openai-responses" as const,
					reasoning: true,
					input: ["text" as const, "image" as const],
					cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
					contextWindow: 1_050_000,
					maxTokens: 128_000,
				},
			],
			checkedAt: Date.now(),
		};
		const store = {
			read: async () => stored,
			write: async (entry: typeof stored) => {
				stored = entry;
			},
			delete: async () => {},
		};
		const context = {
			credential: { type: "api_key" as const, key: "test-key" },
			store,
			allowNetwork: true,
		};

		const firstStartup = codeifyProvider();
		await firstStartup.refreshModels?.(context);
		await firstStartup.refreshModels?.(context);
		const secondStartup = codeifyProvider();
		await secondStartup.refreshModels?.(context);

		const codeifyFetches = fetchSpy.mock.calls.filter(([input]) => String(input) === `${CODEIFY_BASE_URL}/models`);
		expect(codeifyFetches).toHaveLength(2);
	});

	it("takes input modalities from the Codeify v1 catalog", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url === `${CODEIFY_BASE_URL}/models`) {
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "doubao-seed-2.0-lite",
								modalities: { input: ["text", "image", "video"], output: ["text"] },
								input_modalities: ["text", "image", "video"],
							},
							{ id: "mimo-v2.5", input_modalities: ["text", "image", "audio", "video"] },
							{ id: "grok-4.5", input_modalities: ["text", "image", "pdf"] },
							{ id: "glm-5.2-uncensored", modalities: { input: ["text"], output: ["text"] } },
							{ id: "claude-opus-5", input_modalities: ["text"] },
							{ id: "gpt-5.6-sol", input_modalities: ["text"], capabilities: { vision: true } },
						],
					}),
					{ status: 200 },
				);
			}
			return new Response(
				JSON.stringify({
					"claude-opus-5": { id: "claude-opus-5", input: ["text", "image"] },
					"glm-5.2-uncensored": { id: "glm-5.2-uncensored", input: ["text", "image"] },
				}),
				{ status: 200 },
			);
		});
		const models = await codeifyProvider().refreshModels?.({
			credential: { type: "api_key", key: "test-key" },
			store: { read: async () => undefined, write: async () => {}, delete: async () => {} },
			allowNetwork: true,
			force: true,
		});
		const input = (id: string) => models?.find((model) => model.id === id)?.input;

		expect(input("doubao-seed-2.0-lite")).toEqual(["text", "image"]);
		expect(input("mimo-v2.5")).toEqual(["text", "image"]);
		expect(input("grok-4.5")).toEqual(["text", "image"]);
		expect(input("glm-5.2-uncensored")).toEqual(["text"]);
		expect(input("claude-opus-5")).toEqual(["text"]);
		expect(input("gpt-5.6-sol")).toEqual(["text"]);
	});

	it("caches declared modalities so offline reads keep text-only models text-only", async () => {
		let stored: ModelsStoreEntry | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url === `${CODEIFY_BASE_URL}/models`) {
				return new Response(
					JSON.stringify({
						data: [
							{ id: "claude-opus-5", input_modalities: ["text"] },
							{ id: "minimax-m3", input_modalities: ["text", "image", "video"] },
						],
					}),
					{ status: 200 },
				);
			}
			throw new Error("remote catalog unavailable");
		});
		const store = {
			read: async () => stored,
			write: async (entry: ModelsStoreEntry) => {
				stored = entry;
			},
			delete: async () => {},
		};
		await codeifyProvider().refreshModels?.({
			credential: { type: "api_key", key: "test-key" },
			store,
			allowNetwork: true,
			force: true,
		});
		expect(stored?.models.map((model) => (model as { inputModalities?: string[] }).inputModalities)).toEqual([
			["text"],
			["text", "image", "video"],
		]);

		const offline = await codeifyProvider().refreshModels?.({
			credential: undefined,
			store,
			allowNetwork: false,
		});
		expect(offline?.find((model) => model.id === "claude-opus-5")?.input).toEqual(["text"]);
		expect(offline?.find((model) => model.id === "minimax-m3")?.input).toEqual(["text", "image"]);
	});

	it("keeps vision enabled for models missing from both catalogs", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url === `${CODEIFY_BASE_URL}/models`) {
				return new Response(
					JSON.stringify({
						data: [
							{ id: "claude-opus-5", context: 1_000_000 },
							{ id: "claude-haiku-4-5-20251001", context: 200_000 },
							{ id: "glm-5", context: 200_000 },
							{ id: "future-text-model", context: 200_000 },
							{ id: "future-declared-text-model", capabilities: { vision: false } },
						],
					}),
					{ status: 200 },
				);
			}
			throw new Error("remote catalog unavailable");
		});
		const models = await codeifyProvider().refreshModels?.({
			credential: { type: "api_key", key: "test-key" },
			store: { read: async () => undefined, write: async () => {}, delete: async () => {} },
			allowNetwork: true,
			force: true,
		});
		const input = (id: string) => models?.find((model) => model.id === id)?.input;

		expect(input("claude-opus-5")).toEqual(["text", "image"]);
		expect(input("claude-haiku-4-5-20251001")).toEqual(["text", "image"]);
		expect(input("glm-5")).toEqual(["text"]);
		expect(input("future-text-model")).toEqual(["text"]);
		expect(input("future-declared-text-model")).toEqual(["text"]);
	});

	it("re-derives vision support from a cache that downgraded it", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const models = await codeifyProvider().refreshModels?.({
			credential: undefined,
			store: {
				read: async () => ({
					models: [
						{
							id: "claude-opus-5",
							name: "Claude Opus 5",
							provider: "codeify",
							baseUrl: CODEIFY_BASE_URL,
							api: "openai-responses",
							reasoning: true,
							input: ["text"],
							cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
							contextWindow: 1_000_000,
							maxTokens: 128_000,
						},
					],
					checkedAt: Date.now(),
				}),
				write: async () => {},
				delete: async () => {},
			},
			allowNetwork: false,
		});

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(models?.[0]).toMatchObject({ id: "claude-opus-5", contextWindow: 1_000_000, input: ["text", "image"] });
	});

	it("uses PKCE and exchanges only an authorization code", async () => {
		const tokenUrl = "https://auth.codeify.test/oauth/token";
		vi.stubEnv("CODEIFY_OAUTH_TOKEN_URL", tokenUrl);
		const nativeFetch = globalThis.fetch.bind(globalThis);
		const tokenRequests: RequestInit[] = [];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			if (String(input) === tokenUrl) {
				tokenRequests.push(init ?? {});
				return new Response(
					JSON.stringify({
						access_token: "access-token",
						refresh_token: "refresh-token",
						expires_in: 900,
						scope: "codeify:invoke offline_access",
					}),
					{ status: 200 },
				);
			}
			return nativeFetch(input, init);
		});
		let resolveAuth: (url: URL) => void = () => {};
		const authReady = new Promise<URL>((resolve) => {
			resolveAuth = resolve;
		});
		const loginPromise = loginWithCodeifyOAuth(oauthCallbacks(resolveAuth));
		const authorizeUrl = await authReady;
		expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
		expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authorizeUrl.searchParams.get("scope")).toBe("codeify:invoke offline_access");
		expect(authorizeUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(openBrowser).not.toHaveBeenCalled();

		const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
		expect(redirectUri).toBeTruthy();
		const callbackUrl = new URL(redirectUri as string);
		callbackUrl.searchParams.set("state", authorizeUrl.searchParams.get("state") as string);
		callbackUrl.searchParams.set("code", "authorization-code");
		const callbackResponse = await nativeFetch(callbackUrl);
		expect(callbackResponse.status).toBe(200);
		expect(callbackResponse.headers.get("content-type")).toBe("text/html; charset=utf-8");
		const callbackHtml = await callbackResponse.text();
		expect(callbackHtml).toContain("<title>Signed in to Codeify</title>");
		expect(callbackHtml).toContain("You’re signed in.");
		expect(callbackHtml).toContain("Return to your terminal");
		expect(callbackHtml).toContain("font-size: clamp(32px, 7vw, 56px)");
		expect(callbackHtml).not.toContain("This window can be closed");
		expect(callbackHtml).not.toContain("#4ade80");
		expect(callbackHtml).toContain("<style>");

		const credentials = await loginPromise;
		expect(credentials).toMatchObject({ access: "access-token", refresh: "refresh-token" });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const requestBody = new URLSearchParams(String(tokenRequests[0]?.body));
		const verifier = requestBody.get("code_verifier");
		expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(authorizeUrl.searchParams.get("code_challenge")).toBe(
			createHash("sha256")
				.update(verifier as string)
				.digest("base64url"),
		);
		expect(requestBody.get("grant_type")).toBe("authorization_code");
		expect(requestBody.get("code")).toBe("authorization-code");
		expect(requestBody.get("client_id")).toBe("codeify-cli");
		expect(requestBody.get("redirect_uri")).toBe(redirectUri);
	});

	it("requires a rotated refresh token", async () => {
		const tokenUrl = "https://auth.codeify.test/oauth/token";
		vi.stubEnv("CODEIFY_OAUTH_TOKEN_URL", tokenUrl);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 900 }), {
				status: 200,
			}),
		);
		const refreshToken = codeifyProvider().oauth?.refreshToken;
		expect(refreshToken).toBeDefined();
		const result = await refreshToken?.({ access: "old-access", refresh: "old-refresh", expires: 0 });
		expect(result).toMatchObject({ access: "new-access", refresh: "new-refresh" });
		expect(fetchSpy).toHaveBeenCalledWith(
			tokenUrl,
			expect.objectContaining({
				method: "POST",
				body: expect.any(URLSearchParams),
			}),
		);

		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ access_token: "access-only", expires_in: 900 }), { status: 200 }),
		);
		await expect(refreshToken?.({ access: "old-access", refresh: "old-refresh", expires: 0 })).rejects.toThrow(
			"refresh token",
		);
	});

	it("rejects tokens returned in the callback URL", async () => {
		const nativeFetch = globalThis.fetch.bind(globalThis);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			throw new Error("token endpoint must not be called");
		});
		let resolveAuth: (url: URL) => void = () => {};
		const authReady = new Promise<URL>((resolve) => {
			resolveAuth = resolve;
		});
		const loginPromise = loginWithCodeifyOAuth(oauthCallbacks(resolveAuth));
		const authorizeUrl = await authReady;
		const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
		const callbackUrl = new URL(redirectUri as string);
		callbackUrl.searchParams.set("state", authorizeUrl.searchParams.get("state") as string);
		callbackUrl.searchParams.set("access_token", "not-accepted");
		const loginRejection = expect(loginPromise).rejects.toThrow("must not contain tokens");
		const callbackResponse = await nativeFetch(callbackUrl);
		expect(callbackResponse.status).toBe(400);
		await loginRejection;
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
