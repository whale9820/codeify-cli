import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { Model, ModelCost, ModelsStoreEntry, OAuthCredentials, OAuthLoginCallbacks } from "codeify-ai";
import { CODEIFY_DEFAULT_MODEL } from "./defaults.ts";
import type { RuntimeProviderConfig } from "./provider-composer.ts";

export { CODEIFY_DEFAULT_MODEL } from "./defaults.ts";

export const CODEIFY_PROVIDER_ID = "codeify";
export const CODEIFY_BASE_URL = process.env.CODEIFY_BASE_URL ?? "https://codeify.cc/v1";
export const CODEIFY_MODEL_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

type CodeifyModel = {
	id: string;
	context?: number;
	max_tokens?: number;
	max_output_tokens?: number;
	input?: string[];
	input_modalities?: string[];
	modalities?: { input?: string[]; output?: string[] };
	capabilities?: { reasoning?: boolean; vision?: boolean };
	thinkingLevelMap?: Model<"openai-responses">["thinkingLevelMap"];
	cost?: ModelCost;
	pricing?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
		unit?: string;
	};
};

type CodeifyModelDefinition = NonNullable<RuntimeProviderConfig["models"]>[number];

type StoredCodeifyModel = Model<"openai-responses"> & {
	inputModalities?: string[];
	declaredReasoning?: boolean;
};

function positiveNumber(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function pricingToCost(pricing: CodeifyModel["pricing"]): ModelCost | undefined {
	if (!pricing) return undefined;
	const fields = [pricing.input, pricing.output, pricing.cache_read, pricing.cache_write];
	if (!fields.some((value) => typeof value === "number" && Number.isFinite(value))) return undefined;
	const rate = (value: number | undefined): number =>
		typeof value === "number" && Number.isFinite(value) ? value : 0;
	return {
		input: rate(pricing.input),
		output: rate(pricing.output),
		cacheRead: rate(pricing.cache_read),
		cacheWrite: rate(pricing.cache_write),
	};
}

function supportsReasoning(id: string, model: CodeifyModel): boolean {
	if (model.capabilities?.reasoning !== undefined) return model.capabilities.reasoning;
	return /^(gpt-[56]|o[134]|claude|deepseek|gemini|glm|grok|kimi|mimo|minimax|qwen|nemotron|hy3|krenn|laguna)/i.test(
		id,
	);
}

const VISION_MODEL_FAMILIES = /^(claude|gpt-[5-9]|o[134]|gemini|grok-\d)/i;

function toInput(input: readonly string[] | undefined): ("text" | "image")[] | undefined {
	if (!input?.length) return undefined;
	return input.includes("image") ? ["text", "image"] : ["text"];
}

/**
 * `/v1/models` publishes the authoritative supported input modalities per model
 * (`input_modalities`, mirrored by `modalities.input`). Anything else (bundled catalog,
 * pi.dev overlay, id heuristics) is a stale guess, so this wins whenever it is present.
 */
function declaredModalities(model: CodeifyModel): string[] | undefined {
	const declared = [model.input_modalities, model.modalities?.input].find(
		(value): value is string[] => Array.isArray(value) && value.some((entry) => typeof entry === "string"),
	);
	return declared?.filter((entry): entry is string => typeof entry === "string");
}

function resolveInput(model: CodeifyModel): ("text" | "image")[] {
	const declared = toInput(declaredModalities(model));
	if (declared) return declared;
	if (model.capabilities?.vision !== undefined) return model.capabilities.vision ? ["text", "image"] : ["text"];
	return toInput(model.input) ?? (VISION_MODEL_FAMILIES.test(model.id) ? ["text", "image"] : ["text"]);
}

function toModelDefinition(model: CodeifyModel): CodeifyModelDefinition {
	const reasoning = model.capabilities?.reasoning ?? supportsReasoning(model.id, model);
	const contextWindow = /^gpt-5\.[56](?:-|$)/i.test(model.id)
		? Math.max(positiveNumber(model.context) ?? 0, 1_050_000)
		: (positiveNumber(model.context) ?? 272_000);
	const maxTokens = positiveNumber(model.max_tokens ?? model.max_output_tokens) ?? 32_768;
	return {
		id: model.id,
		name: model.id,
		api: "openai-responses",
		reasoning,
		thinkingLevelMap:
			model.thinkingLevelMap ?? (reasoning ? { off: "none", xhigh: "xhigh", max: "max" } : { off: null }),
		input: resolveInput(model),
		cost: pricingToCost(model.pricing) ?? model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
		compat: { supportsToolSearch: true, promoteToolResultImages: true },
	};
}

/**
 * Cached entries retain declared modalities when the Codeify catalog supplied them;
 * otherwise model-family heuristics are recalculated for offline startup.
 */
function cachedCodeifyModel(model: StoredCodeifyModel): CodeifyModel {
	const input = model.inputModalities?.length
		? model.inputModalities
		: model.input.includes("image")
			? ["text", "image"]
			: undefined;
	return {
		id: model.id,
		context: model.contextWindow,
		max_tokens: model.maxTokens,
		cost: model.cost,
		input_modalities: input,
		...(model.declaredReasoning === undefined && /^gpt-6/i.test(model.id) && !model.reasoning
			? {}
			: {
					capabilities: { reasoning: model.declaredReasoning ?? model.reasoning },
					thinkingLevelMap: model.thinkingLevelMap,
				}),
	};
}

async function fetchModels(
	apiKey: string,
	store: { read: () => Promise<ModelsStoreEntry | undefined>; write: (entry: ModelsStoreEntry) => Promise<void> },
	signal?: AbortSignal,
	force?: boolean,
	allowNetwork = true,
): Promise<NonNullable<RuntimeProviderConfig["models"]>> {
	const stored = await store.read();
	const cached = stored?.models
		.filter((model): model is StoredCodeifyModel => model.provider === CODEIFY_PROVIDER_ID)
		.map((model) => toModelDefinition(cachedCodeifyModel(model)));
	if (!allowNetwork || signal?.aborted)
		return cached?.length ? cached : [toModelDefinition({ id: CODEIFY_DEFAULT_MODEL })];
	if (
		!force &&
		stored?.checkedAt !== undefined &&
		Date.now() - stored.checkedAt < CODEIFY_MODEL_REFRESH_INTERVAL_MS &&
		cached?.length
	) {
		return cached;
	}

	const codeifyResponse = await fetch(`${CODEIFY_BASE_URL}/models`, {
		headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
		signal,
	});
	if (!codeifyResponse.ok) throw new Error(`Codeify CLI model discovery failed (${codeifyResponse.status})`);
	const payload = (await codeifyResponse.json()) as { data?: CodeifyModel[] };
	const models = (payload.data ?? []).filter((model) => typeof model.id === "string" && model.id.length > 0);
	const discovered: CodeifyModel[] = models.length > 0 ? models : [{ id: CODEIFY_DEFAULT_MODEL }];
	const definitions: CodeifyModelDefinition[] = [];
	const storedModels: StoredCodeifyModel[] = [];
	for (const model of discovered) {
		const definition = toModelDefinition(model);
		const inputModalities = declaredModalities(model);
		const declaredReasoning = model.capabilities?.reasoning;
		definitions.push(definition);
		storedModels.push({
			...definition,
			...(inputModalities?.length ? { inputModalities } : {}),
			...(declaredReasoning !== undefined ? { declaredReasoning } : {}),
			api: "openai-responses",
			provider: CODEIFY_PROVIDER_ID,
			baseUrl: CODEIFY_BASE_URL,
		});
	}
	await store.write({
		models: storedModels,
		checkedAt: Date.now(),
		lastModified: stored?.lastModified ?? 0,
	});
	return definitions;
}

function getOAuthClientId(): string {
	return process.env.CODEIFY_OAUTH_CLIENT_ID ?? "codeify-cli";
}

function getOAuthScope(): string {
	return process.env.CODEIFY_OAUTH_SCOPE ?? "codeify:invoke offline_access";
}

function getOAuthAuthorizeUrl(): string {
	return process.env.CODEIFY_OAUTH_AUTHORIZE_URL ?? "https://codeify.cc/oauth/authorize";
}

function getOAuthTokenUrl(): string {
	return process.env.CODEIFY_OAUTH_TOKEN_URL ?? "https://codeify.cc/oauth/token";
}

function secureEquals(expected: string, actual: string | null): boolean {
	if (!actual) return false;
	const expectedBytes = Buffer.from(expected);
	const actualBytes = Buffer.from(actual);
	return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function oauthSuccessHtml(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signed in to Codeify</title>
<style>
:root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 20px; background: #09090b; color: #fafafa; }
main { width: min(100%, 460px); border-top: 1px solid #fafafa; padding-top: 28px; }
mark { display: inline-block; margin-bottom: 20px; padding: 5px 9px; background: #fafafa; color: #09090b; font: 700 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: .08em; text-transform: uppercase; }
h1 { max-width: 12ch; margin: 0 0 14px; font-size: clamp(32px, 7vw, 56px); line-height: .98; letter-spacing: -.045em; }
p { max-width: 42ch; margin: 0; color: #a1a1aa; font-size: 15px; line-height: 1.55; }
</style>
</head>
<body>
<main>
<mark>Codeify CLI</mark>
<h1>You’re signed in.</h1>
<p>Authentication is complete. Return to your terminal to continue working.</p>
</main>
</body>
</html>`;
}

type OAuthTokenPayload = {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
	scope?: unknown;
};

function parseOAuthTokenPayload(payload: unknown): OAuthCredentials {
	const tokenPayload: OAuthTokenPayload =
		typeof payload === "object" && payload !== null ? (payload as OAuthTokenPayload) : {};
	if (typeof tokenPayload.access_token !== "string" || tokenPayload.access_token.length === 0) {
		throw new Error("Codeify OAuth did not return an access token");
	}
	if (typeof tokenPayload.refresh_token !== "string" || tokenPayload.refresh_token.length === 0) {
		throw new Error("Codeify OAuth did not return a refresh token");
	}
	if (
		typeof tokenPayload.expires_in !== "number" ||
		!Number.isFinite(tokenPayload.expires_in) ||
		tokenPayload.expires_in <= 0
	) {
		throw new Error("Codeify OAuth returned an invalid access-token lifetime");
	}
	const expires = Date.now() + tokenPayload.expires_in * 1000;
	if (!Number.isFinite(expires)) throw new Error("Codeify OAuth returned an invalid access-token lifetime");
	return {
		access: tokenPayload.access_token,
		refresh: tokenPayload.refresh_token,
		expires,
		...(typeof tokenPayload.scope === "string" ? { scope: tokenPayload.scope } : {}),
	};
}

function oauthAuthorizeUrl(redirectUri: string, state: string, codeChallenge: string): string {
	const url = new URL(getOAuthAuthorizeUrl());
	url.searchParams.set("client_id", getOAuthClientId());
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("state", state);
	url.searchParams.set("scope", getOAuthScope());
	url.searchParams.set("code_challenge", codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	return url.toString();
}

async function exchangeOAuthCode(code: string, redirectUri: string, codeVerifier: string): Promise<OAuthCredentials> {
	const response = await fetch(getOAuthTokenUrl(), {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			client_id: getOAuthClientId(),
			redirect_uri: redirectUri,
			code_verifier: codeVerifier,
		}),
	});
	if (!response.ok) throw new Error(`Codeify OAuth token exchange failed (${response.status})`);
	return parseOAuthTokenPayload(await response.json());
}

export async function loginWithCodeifyOAuth(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	if (callbacks.signal?.aborted) throw new Error("Login cancelled");
	const state = randomBytes(32).toString("hex");
	const codeVerifier = randomBytes(32).toString("base64url");
	const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
	const server = createServer();
	let redirectUri = "";
	let completed = false;
	const result = new Promise<OAuthCredentials>((resolve, reject) => {
		server.on("request", async (request, response) => {
			let requestUrl: URL;
			try {
				requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
			} catch {
				response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Invalid OAuth callback.");
				return;
			}
			try {
				if (requestUrl.pathname !== "/callback") {
					response.writeHead(404).end();
					return;
				}
				if (request.method !== "GET") {
					response.writeHead(405).end();
					return;
				}
				if (completed) {
					response.writeHead(409).end();
					return;
				}
				if (!secureEquals(state, requestUrl.searchParams.get("state"))) {
					response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Invalid OAuth state.");
					return;
				}
				const error = requestUrl.searchParams.get("error");
				if (error) {
					const description = requestUrl.searchParams.get("error_description");
					throw new Error(`Codeify OAuth failed: ${description ?? error}`);
				}
				if (requestUrl.searchParams.has("access_token") || requestUrl.searchParams.has("refresh_token")) {
					throw new Error("Codeify OAuth callback must not contain tokens");
				}
				const code = requestUrl.searchParams.get("code");
				if (!code) throw new Error("Codeify OAuth callback did not include an authorization code");
				const credential = await exchangeOAuthCode(code, redirectUri, codeVerifier);
				completed = true;
				response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(oauthSuccessHtml());
				resolve(credential);
			} catch (error) {
				if (completed) return;
				completed = true;
				response
					.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
					.end("Codeify sign-in failed. Return to the CLI.");
				reject(error);
			}
		});
		server.on("error", reject);
	});
	void result.catch(() => {});
	await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", () => resolve()).on("error", reject));
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Unable to start the Codeify OAuth callback server");
	}
	redirectUri = `http://127.0.0.1:${address.port}/callback`;
	let timeout: NodeJS.Timeout | undefined;
	let onAbort: (() => void) | undefined;
	try {
		const url = oauthAuthorizeUrl(redirectUri, state, codeChallenge);
		callbacks.onAuth({ url, instructions: "Complete Codeify sign-in in your browser." });
		return await Promise.race([
			result,
			new Promise<OAuthCredentials>((_, reject) => {
				timeout = setTimeout(() => reject(new Error("Codeify OAuth timed out")), 5 * 60 * 1000);
				onAbort = () => {
					if (timeout) clearTimeout(timeout);
					reject(new Error("Login cancelled"));
				};
				callbacks.signal?.addEventListener("abort", onAbort, { once: true });
				if (callbacks.signal?.aborted) onAbort();
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
		if (onAbort) callbacks.signal?.removeEventListener("abort", onAbort);
		server.close();
	}
}

export function codeifyProvider(): RuntimeProviderConfig {
	let networkRefreshed = false;
	return {
		name: "Codeify",
		baseUrl: CODEIFY_BASE_URL,
		api: "openai-responses",
		apiKey: "$CODEIFY_API_KEY",
		oauth: {
			name: "Codeify",
			login: loginWithCodeifyOAuth,
			refreshToken: async (credentials) => {
				const response = await fetch(getOAuthTokenUrl(), {
					method: "POST",
					headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						grant_type: "refresh_token",
						refresh_token: credentials.refresh,
						client_id: getOAuthClientId(),
					}),
				});
				if (!response.ok) throw new Error(`Codeify OAuth refresh failed (${response.status})`);
				return {
					...credentials,
					...parseOAuthTokenPayload(await response.json()),
				};
			},
			getApiKey: (credentials) => credentials.access,
		},
		models: [toModelDefinition({ id: CODEIFY_DEFAULT_MODEL })],
		refreshModels: async (context) => {
			const apiKey = context.credential?.type === "oauth" ? context.credential.access : context.credential?.key;
			const allowNetwork = Boolean(apiKey) && context.allowNetwork;
			const models = await fetchModels(
				apiKey ?? "",
				context.store,
				context.signal,
				context.force || !networkRefreshed,
				allowNetwork,
			);
			if (allowNetwork) networkRefreshed = true;
			return models;
		},
	};
}
