import { createHash } from "node:crypto";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CODEIFY_BASE_URL,
	CODEIFY_CATALOG_BASE_URL,
	CODEIFY_CATALOG_PROVIDER,
	codeifyProvider,
	loginWithCodeifyOAuth,
} from "../src/core/codeify-provider.ts";
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
	it("uses Codeify service branding and the bundled catalog for the initial default model", () => {
		const provider = codeifyProvider();
		const model = provider.models?.find((candidate) => candidate.id === "gpt-5.6-sol");

		expect(provider).toMatchObject({ name: "Codeify", oauth: { name: "Codeify" } });
		expect(model).toMatchObject({ contextWindow: 1_050_000, maxTokens: 128_000 });
	});

	it("joins Codeify availability with Pi's remote model metadata", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url === `${CODEIFY_BASE_URL}/models`) {
				return new Response(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }), { status: 200 });
			}
			expect(url).toBe(`${CODEIFY_CATALOG_BASE_URL}/api/models/providers/${CODEIFY_CATALOG_PROVIDER}`);
			return new Response(
				JSON.stringify({
					"gpt-5.6-sol": {
						id: "gpt-5.6-sol",
						name: "GPT-5.6 Sol",
						contextWindow: 1_050_000,
						maxTokens: 128_000,
						reasoning: true,
						thinkingLevelMap: { off: null, low: "low", high: "high", max: "max" },
						input: ["text", "image"],
						cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
						compat: { sessionAffinityFormat: "openai-nosession" },
					},
				}),
				{ status: 200, headers: { "last-modified": "Wed, 22 Jul 2026 12:49:31 GMT" } },
			);
		});
		const provider = codeifyProvider();
		const models = await provider.refreshModels?.({
			credential: { type: "api_key", key: "test-key" },
			store: {
				read: async () => undefined,
				write: async (entry) => {
					expect(entry.models[0]).toMatchObject({
						provider: "codeify",
						contextWindow: 1_050_000,
						maxTokens: 128_000,
					});
				},
				delete: async () => {},
			},
			allowNetwork: true,
			force: true,
		});

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(models?.[0]).toMatchObject({
			contextWindow: 1_050_000,
			maxTokens: 128_000,
			cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
			thinkingLevelMap: { off: null, low: "low", high: "high", max: "max" },
			compat: { sessionAffinityFormat: "openai-nosession", supportsToolSearch: true },
		});
	});

	it("restores a cached remote catalog without network access", async () => {
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
