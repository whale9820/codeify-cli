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
	name?: string;
	display_name?: string;
	context?: number;
	context_window?: number;
	contextWindow?: number;
	context_length?: number;
	max_context_tokens?: number;
	max_input_tokens?: number;
	max_tokens?: number;
	maxTokens?: number;
	max_output_tokens?: number;
	maxOutputTokens?: number;
	output_tokens?: number;
	limit?: {
		context?: number;
		input?: number;
		output?: number;
	};
	input?: string[];
	input_modalities?: string[];
	inputModalities?: string[];
	input_types?: string[];
	inputTypes?: string[];
	output_types?: string[];
	modalities?: { input?: string[]; output?: string[] };
	reasoning?:
		| boolean
		| {
				effort?: string[] | string;
				efforts?: string[];
				effort_levels?: string[];
				levels?: string[];
				values?: string[];
		  };
	capabilities?: {
		reasoning?: boolean;
		vision?: boolean;
		thinking_levels?: string[];
		thinkingLevels?: string[];
		reasoning_efforts?: string[];
		reasoningEfforts?: string[];
		effort_levels?: string[];
		effortLevels?: string[];
		supported_thinking_levels?: string[];
		supported_reasoning_efforts?: string[];
		reasoning_options?: Array<{ type?: string; values?: string[] }> | { values?: string[] };
		reasoningOptions?: Array<{ type?: string; values?: string[] }> | { values?: string[] };
		thinkingLevelMap?: Model<"openai-responses">["thinkingLevelMap"];
		thinking_level_map?: Model<"openai-responses">["thinkingLevelMap"];
	};
	thinking_levels?: string[];
	thinkingLevels?: string[];
	reasoning_efforts?: string[];
	reasoningEfforts?: string[];
	effort_levels?: string[];
	effortLevels?: string[];
	supported_thinking_levels?: string[];
	supported_reasoning_efforts?: string[];
	reasoning_options?: Array<{ type?: string; values?: string[] }> | { values?: string[] };
	reasoningOptions?: Array<{ type?: string; values?: string[] }> | { values?: string[] };
	thinkingLevelMap?: Model<"openai-responses">["thinkingLevelMap"];
	thinking_level_map?: Model<"openai-responses">["thinkingLevelMap"];
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
	declaredThinkingLevels?: string[];
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

function extractDeclaredThinkingLevels(model: CodeifyModel): string[] | undefined {
	const candidates = [
		model.thinking_levels,
		model.thinkingLevels,
		model.reasoning_efforts,
		model.reasoningEfforts,
		model.effort_levels,
		model.effortLevels,
		model.supported_thinking_levels,
		model.supported_reasoning_efforts,
		model.capabilities?.thinking_levels,
		model.capabilities?.thinkingLevels,
		model.capabilities?.reasoning_efforts,
		model.capabilities?.reasoningEfforts,
		model.capabilities?.effort_levels,
		model.capabilities?.effortLevels,
		model.capabilities?.supported_thinking_levels,
		model.capabilities?.supported_reasoning_efforts,
		typeof model.reasoning === "object" && model.reasoning !== null
			? (model.reasoning.efforts ??
				model.reasoning.effort_levels ??
				model.reasoning.levels ??
				model.reasoning.values ??
				(Array.isArray(model.reasoning.effort) ? model.reasoning.effort : undefined))
			: undefined,
	];

	for (const candidate of candidates) {
		if (Array.isArray(candidate) && candidate.some((entry) => typeof entry === "string")) {
			return candidate.filter((entry): entry is string => typeof entry === "string");
		}
	}

	const reasoningOptions =
		model.reasoning_options ??
		model.reasoningOptions ??
		model.capabilities?.reasoning_options ??
		model.capabilities?.reasoningOptions;

	if (Array.isArray(reasoningOptions)) {
		const effortOption =
			reasoningOptions.find((opt) => opt?.type === "effort" && Array.isArray(opt.values)) ??
			reasoningOptions.find((opt) => Array.isArray(opt?.values));
		if (effortOption?.values?.some((entry) => typeof entry === "string")) {
			return effortOption.values.filter((entry): entry is string => typeof entry === "string");
		}
	} else if (reasoningOptions && typeof reasoningOptions === "object" && Array.isArray(reasoningOptions.values)) {
		return reasoningOptions.values.filter((entry): entry is string => typeof entry === "string");
	}

	return undefined;
}

function extractDeclaredThinkingMap(model: CodeifyModel): Model<"openai-responses">["thinkingLevelMap"] | undefined {
	const map =
		model.thinkingLevelMap ??
		model.thinking_level_map ??
		model.capabilities?.thinkingLevelMap ??
		model.capabilities?.thinking_level_map;
	if (map && typeof map === "object" && !Array.isArray(map)) {
		return map;
	}
	return undefined;
}

function resolveThinkingLevelMap(
	model: CodeifyModel,
	reasoning: boolean,
): Model<"openai-responses">["thinkingLevelMap"] {
	if (!reasoning) {
		return { off: null };
	}

	const declaredLevels = extractDeclaredThinkingLevels(model);
	if (declaredLevels) {
		const normalized = new Set(declaredLevels.map((l) => l.trim().toLowerCase()));
		const hasNone = normalized.has("none");
		const hasOff = normalized.has("off") || normalized.has("disabled");
		const offValue: string | null = hasNone ? "none" : hasOff ? "off" : null;

		return {
			off: offValue,
			minimal: normalized.has("minimal") ? "minimal" : null,
			low: normalized.has("low") ? "low" : null,
			medium: normalized.has("medium") ? "medium" : null,
			high: normalized.has("high") ? "high" : null,
			xhigh:
				normalized.has("xhigh") || normalized.has("extra-high") || normalized.has("extra_high") ? "xhigh" : null,
			max: normalized.has("max") || normalized.has("maximum") ? "max" : null,
		};
	}

	const declaredMap = extractDeclaredThinkingMap(model);
	if (declaredMap) {
		return declaredMap;
	}

	return { off: "none", xhigh: "xhigh", max: "max" };
}

function supportsReasoning(id: string, model: CodeifyModel): boolean {
	if (typeof model.reasoning === "boolean") return model.reasoning;
	if (model.capabilities?.reasoning !== undefined) return model.capabilities.reasoning;
	if (extractDeclaredThinkingLevels(model) !== undefined) return true;
	return /^(gpt-[56]|o[134]|claude|deepseek|gemini|glm|grok|kimi|mimo|minimax|qwen|nemotron|hy3|krenn|laguna|step)/i.test(
		id,
	);
}

const VISION_MODEL_FAMILIES = /^(claude|gpt-[5-9]|o[134]|gemini|grok-\d|step)/i;

function toInput(input: readonly string[] | undefined): ("text" | "image")[] | undefined {
	if (!input?.length) return undefined;
	const lower = input.map((val) => (typeof val === "string" ? val.toLowerCase() : ""));
	const hasVision =
		lower.includes("image") || lower.includes("images") || lower.includes("video") || lower.includes("videos");
	return hasVision ? ["text", "image"] : ["text"];
}

/**
 * `/v1/models` publishes the authoritative supported input modalities per model
 * (`input_modalities`, mirrored by `modalities.input`). Anything else (bundled catalog,
 * pi.dev overlay, id heuristics) is a stale guess, so this wins whenever it is present.
 */
function declaredModalities(model: CodeifyModel): string[] | undefined {
	const candidates = [
		model.input_modalities,
		model.inputModalities,
		model.modalities?.input,
		model.input_types,
		model.inputTypes,
		Array.isArray(model.input) ? model.input : undefined,
	];
	const declared = candidates.find(
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

function resolveContextWindow(model: CodeifyModel): number {
	const raw =
		model.context ??
		model.context_window ??
		model.contextWindow ??
		model.context_length ??
		model.max_context_tokens ??
		model.max_input_tokens ??
		model.limit?.context ??
		model.limit?.input;
	const parsed = positiveNumber(raw);
	if (/^gpt-5\.[56](?:-|$)/i.test(model.id)) {
		return Math.max(parsed ?? 0, 1_050_000);
	}
	return parsed ?? 272_000;
}

function resolveMaxTokens(model: CodeifyModel): number {
	const raw =
		model.max_tokens ??
		model.maxTokens ??
		model.max_output_tokens ??
		model.maxOutputTokens ??
		model.output_tokens ??
		model.limit?.output;
	return positiveNumber(raw) ?? 32_768;
}

function toModelDefinition(model: CodeifyModel): CodeifyModelDefinition {
	const reasoning = supportsReasoning(model.id, model);
	const contextWindow = resolveContextWindow(model);
	const maxTokens = resolveMaxTokens(model);
	return {
		id: model.id,
		name: model.id,
		api: "openai-responses",
		reasoning,
		thinkingLevelMap: resolveThinkingLevelMap(model, reasoning),
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
		...(model.declaredThinkingLevels?.length ? { thinking_levels: model.declaredThinkingLevels } : {}),
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

	let payload: { data?: CodeifyModel[] };
	try {
		const codeifyResponse = await fetch(`${CODEIFY_BASE_URL}/models`, {
			headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
			signal,
		});
		if (!codeifyResponse.ok) {
			if (cached?.length) return cached;
			throw new Error(
				`Codeify model discovery failed (${codeifyResponse.status}). Please check your connection or reopen Codeify.`,
			);
		}
		payload = (await codeifyResponse.json()) as { data?: CodeifyModel[] };
	} catch (error) {
		if (cached?.length) return cached;
		throw new Error(
			`Could not reach Codeify API (${error instanceof Error ? error.message : String(error)}). Please check your connection or reopen Codeify.`,
		);
	}
	const models = (payload.data ?? []).filter((model) => typeof model.id === "string" && model.id.length > 0);
	const discovered: CodeifyModel[] = models.length > 0 ? models : [{ id: CODEIFY_DEFAULT_MODEL }];
	const definitions: CodeifyModelDefinition[] = [];
	const storedModels: StoredCodeifyModel[] = [];
	for (const model of discovered) {
		const definition = toModelDefinition(model);
		const inputModalities = declaredModalities(model);
		const declaredReasoning =
			model.capabilities?.reasoning ?? (typeof model.reasoning === "boolean" ? model.reasoning : undefined);
		const declaredThinkingLevels = extractDeclaredThinkingLevels(model);
		definitions.push(definition);
		storedModels.push({
			...definition,
			...(inputModalities?.length ? { inputModalities } : {}),
			...(declaredReasoning !== undefined ? { declaredReasoning } : {}),
			...(declaredThinkingLevels?.length ? { declaredThinkingLevels } : {}),
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
