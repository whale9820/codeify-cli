import {
	type Api,
	type ApiKeyAuth,
	type AssistantMessageEventStream,
	type AuthContext,
	type AuthInteraction,
	type AuthResult,
	type Context,
	type Credential,
	lazyStream,
	type Model,
	type ModelAuth,
	type OAuthAuth,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type Provider,
	type ProviderHeaders,
	type RefreshModelsContext,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import type { ModelConfig, ModelsJsonModel, ModelsJsonModelOverride, ModelsJsonProvider } from "./model-config.ts";
import {
	clearConfigValueCache,
	getConfigValueEnvVarNames,
	isCommandConfigValue,
	isConfigValueConfigured,
	resolveConfigValueOrThrow,
	resolveHeadersOrThrow,
} from "./resolve-config-value.ts";

export interface RuntimeOAuthConfig {
	name: string;
	usesCallbackServer?: boolean;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
	modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
}

export interface RuntimeProviderConfig {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	headers?: Record<string, string>;
	authHeader?: boolean;
	oauth?: RuntimeOAuthConfig;
	models?: Array<{
		id: string;
		name: string;
		api?: Api;
		baseUrl?: string;
		reasoning: boolean;
		thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
		input: ("text" | "image")[];
		cost: Model<Api>["cost"];
		contextWindow: number;
		maxTokens: number;
		headers?: Record<string, string>;
		compat?: Model<Api>["compat"];
	}>;
	refreshModels?(context: RefreshModelsContext): Promise<NonNullable<RuntimeProviderConfig["models"]>>;
}

export type AuthStatus = {
	configured: boolean;
	source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	label?: string;
};

export const clearApiKeyCache = clearConfigValueCache;

function mergeCompat(
	base: Model<Api>["compat"],
	override: Model<Api>["compat"] | ModelsJsonModelOverride["compat"],
): Model<Api>["compat"] {
	if (!override) return base;
	const merged = { ...base, ...override } as NonNullable<Model<Api>["compat"]>;
	const baseNested = base as Record<string, unknown> | undefined;
	const overrideNested = override as Record<string, unknown>;
	const mergedNested = merged as Record<string, unknown>;
	for (const key of ["openRouterRouting", "vercelGatewayRouting", "chatTemplateKwargs"] as const) {
		const baseValue = baseNested?.[key];
		const overrideValue = overrideNested[key];
		if (
			(typeof baseValue === "object" && baseValue !== null) ||
			(typeof overrideValue === "object" && overrideValue !== null)
		) {
			mergedNested[key] = { ...(baseValue as object | undefined), ...(overrideValue as object | undefined) };
		}
	}
	return merged;
}

function applyModelOverride(model: Model<Api>, override: ModelsJsonModelOverride): Model<Api> {
	return {
		...model,
		name: override.name ?? model.name,
		reasoning: override.reasoning ?? model.reasoning,
		thinkingLevelMap: override.thinkingLevelMap
			? { ...model.thinkingLevelMap, ...override.thinkingLevelMap }
			: model.thinkingLevelMap,
		input: (override.input as ("text" | "image")[] | undefined) ?? model.input,
		cost: override.cost
			? {
					input: override.cost.input ?? model.cost.input,
					output: override.cost.output ?? model.cost.output,
					cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
					cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
					tiers: override.cost.tiers ?? model.cost.tiers,
				}
			: model.cost,
		contextWindow: override.contextWindow ?? model.contextWindow,
		maxTokens: override.maxTokens ?? model.maxTokens,
		compat: mergeCompat(model.compat, override.compat),
	};
}

function modelFromJson(
	providerId: string,
	definition: ModelsJsonModel,
	providerConfig: ModelsJsonProvider,
	defaults: Model<Api> | undefined,
): Model<Api> {
	const api = definition.api ?? providerConfig.api ?? defaults?.api;
	if (!api) {
		throw new Error(
			`Provider ${providerId}, model ${definition.id}: no "api" specified. Set at provider or model level.`,
		);
	}
	const baseUrl = definition.baseUrl ?? providerConfig.baseUrl ?? defaults?.baseUrl;
	if (!baseUrl) throw new Error(`Provider ${providerId}: "baseUrl" is required when defining custom models.`);
	if (definition.contextWindow !== undefined && definition.contextWindow <= 0) {
		throw new Error(`Provider ${providerId}, model ${definition.id}: invalid contextWindow`);
	}
	if (definition.maxTokens !== undefined && definition.maxTokens <= 0) {
		throw new Error(`Provider ${providerId}, model ${definition.id}: invalid maxTokens`);
	}
	return {
		id: definition.id,
		name: definition.name ?? definition.id,
		api: api as Api,
		provider: providerId,
		baseUrl,
		reasoning: definition.reasoning ?? false,
		thinkingLevelMap: definition.thinkingLevelMap,
		input: (definition.input ?? ["text"]) as ("text" | "image")[],
		cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: definition.contextWindow ?? 128000,
		maxTokens: definition.maxTokens ?? 16384,
		headers: undefined,
		compat: mergeCompat(providerConfig.compat, definition.compat),
	};
}

function applyModelsJson(
	providerId: string,
	baseModels: readonly Model<Api>[],
	config: ModelsJsonProvider | undefined,
): Model<Api>[] {
	if (!config) return [...baseModels];
	if (config.oauth && !config.baseUrl) {
		throw new Error(`Provider ${providerId}: "baseUrl" is required when "oauth" is set.`);
	}
	const hasOverrides = config.modelOverrides && Object.keys(config.modelOverrides).length > 0;
	if (
		!config.models?.length &&
		!config.baseUrl &&
		!config.headers &&
		!config.compat &&
		!hasOverrides &&
		!config.apiKey &&
		!config.oauth &&
		config.authHeader === undefined
	) {
		throw new Error(
			`Provider ${providerId}: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models".`,
		);
	}

	const models: Model<Api>[] = baseModels.map((model) => ({
		...model,
		baseUrl: config.oauth === "radius" ? model.baseUrl : (config.baseUrl ?? model.baseUrl),
		compat: mergeCompat(model.compat, config.compat),
	}));
	for (const definition of config.models ?? []) {
		const existingIndex = models.findIndex((model) => model.id === definition.id);
		const defaults = existingIndex >= 0 ? models[existingIndex] : models[0];
		const model = modelFromJson(providerId, definition, config, defaults);
		if (existingIndex >= 0) models[existingIndex] = model;
		else models.push(model);
	}
	return models;
}

function applyProviderConfig(
	providerId: string,
	models: readonly Model<Api>[],
	config: RuntimeProviderConfig | undefined,
): Model<Api>[] {
	if (!config) return [...models];
	if (!config.models) {
		return config.baseUrl ? models.map((model) => ({ ...model, baseUrl: config.baseUrl! })) : [...models];
	}
	return config.models.map((definition) => {
		const defaults = models.find((model) => model.id === definition.id) ?? models[0];
		const api = definition.api ?? config.api ?? defaults?.api;
		if (!api) {
			throw new Error(
				`Provider ${providerId}, model ${definition.id}: no "api" specified. Set at provider or model level.`,
			);
		}
		const baseUrl = definition.baseUrl ?? config.baseUrl ?? defaults?.baseUrl;
		if (!baseUrl) throw new Error(`Provider ${providerId}: "baseUrl" is required when defining custom models.`);
		return {
			...definition,
			api,
			provider: providerId,
			baseUrl,
			headers: undefined,
		};
	});
}

function adaptOAuth(config: RuntimeOAuthConfig): OAuthAuth {
	return {
		name: config.name,
		login: async (callbacks) => {
			const credential = await config.login({
				onAuth: (info) => callbacks.notify({ type: "auth_url", ...info }),
				onDeviceCode: (info) => callbacks.notify({ type: "device_code", ...info }),
				onPrompt: (prompt) => callbacks.prompt({ type: "text", ...prompt }),
				onProgress: (message) => callbacks.notify({ type: "progress", message }),
				onManualCodeInput: () => callbacks.prompt({ type: "manual_code", message: "Paste the authorization code" }),
				onSelect: (prompt) => callbacks.prompt({ type: "select", ...prompt }),
				signal: callbacks.signal,
			});
			return { ...credential, type: "oauth" };
		},
		refresh: async (credential) => ({ ...(await config.refreshToken(credential)), type: "oauth" }),
		toAuth: async (credential) => ({ apiKey: config.getApiKey(credential) }),
	};
}

function withConfiguredAuth(
	auth: ModelAuth,
	headers: Record<string, string> | undefined,
	authHeader: boolean,
): ModelAuth {
	let mergedHeaders: ProviderHeaders | undefined =
		auth.headers || headers ? { ...auth.headers, ...headers } : undefined;
	if (authHeader) {
		if (!auth.apiKey) throw new Error("authHeader requires a resolved API key");
		mergedHeaders = { ...mergedHeaders, Authorization: `Bearer ${auth.apiKey}` };
	}
	return { ...auth, headers: mergedHeaders };
}

function configuredApiKey(
	config: ModelsJsonProvider | undefined,
	configured: RuntimeProviderConfig | undefined,
): string | undefined {
	return configured?.apiKey ?? config?.apiKey;
}

function configuredHeaders(
	config: ModelsJsonProvider | undefined,
	configured: RuntimeProviderConfig | undefined,
): Record<string, string> | undefined {
	if (!config?.headers && !configured?.headers) return undefined;
	return { ...config?.headers, ...configured?.headers };
}

async function configContextEnv(
	values: readonly string[],
	ctx: AuthContext,
	explicit?: Record<string, string>,
): Promise<Record<string, string> | undefined> {
	const env = { ...explicit };
	for (const name of new Set(values.flatMap(getConfigValueEnvVarNames))) {
		if (env[name] !== undefined) continue;
		const value = await ctx.env(name);
		if (value !== undefined) env[name] = value;
	}
	return Object.keys(env).length > 0 ? env : undefined;
}

function composeApiKeyAuth(
	providerId: string,
	base: Provider | undefined,
	config: ModelsJsonProvider | undefined,
	configured: RuntimeProviderConfig | undefined,
): ApiKeyAuth | undefined {
	const inherited = base?.auth.apiKey;
	const rawKey = configuredApiKey(config, configured);
	const oauth = configured?.oauth ?? base?.auth.oauth;
	// OAuth-only providers get no fabricated API-key login method.
	if (!inherited && rawKey === undefined && oauth) return undefined;
	const rawHeaders = configuredHeaders(config, configured);
	const authHeader = configured?.authHeader ?? config?.authHeader ?? false;
	return {
		name: inherited?.name ?? "API key",
		login:
			inherited?.login ??
			(async (interaction: AuthInteraction) => ({
				type: "api_key",
				key: await interaction.prompt({ type: "secret", message: "Enter API key" }),
			})),
		check: async (input) => {
			if (input.credential) {
				if (inherited?.check) return inherited.check(input);
				if (input.credential.key) return { type: "api_key", source: "stored credential" };
				const resolved = await inherited?.resolve(input);
				return resolved ? { type: "api_key", source: resolved.source } : undefined;
			}
			if (rawKey !== undefined) {
				if (isCommandConfigValue(rawKey)) return { type: "api_key", source: "configured API key" };
				const envNames = getConfigValueEnvVarNames(rawKey);
				for (const name of envNames) {
					if ((await input.ctx.env(name)) === undefined) return undefined;
				}
				return { type: "api_key", source: "configured API key" };
			}
			if (inherited?.check) return inherited.check(input);
			const resolved = await inherited?.resolve(input);
			return resolved ? { type: "api_key", source: resolved.source } : undefined;
		},
		resolve: async (input) => {
			let result: AuthResult | undefined;
			if (input.credential) {
				result = inherited
					? await inherited.resolve(input)
					: input.credential.key
						? { auth: { apiKey: input.credential.key }, env: input.credential.env, source: "stored credential" }
						: undefined;
			} else if (rawKey !== undefined) {
				const env = await configContextEnv([rawKey], input.ctx);
				const key = resolveConfigValueOrThrow(rawKey, `API key for provider "${providerId}"`, env);
				result = inherited
					? await inherited.resolve({ ...input, credential: { type: "api_key", key } })
					: { auth: { apiKey: key }, source: "configured API key" };
			} else {
				result = await inherited?.resolve(input);
			}
			if (!result) return undefined;
			const explicitEnv = { ...(input.credential?.env ?? {}), ...(result.env ?? {}) };
			const headerEnv = await configContextEnv(Object.values(rawHeaders ?? {}), input.ctx, explicitEnv);
			const headers = resolveHeadersOrThrow(rawHeaders, `provider "${providerId}"`, headerEnv);
			return { ...result, auth: withConfiguredAuth(result.auth, headers, authHeader) };
		},
	};
}

function composeOAuthAuth(
	providerId: string,
	base: Provider | undefined,
	config: ModelsJsonProvider | undefined,
	configured: RuntimeProviderConfig | undefined,
): OAuthAuth | undefined {
	const oauth = configured?.oauth ? adaptOAuth(configured.oauth) : base?.auth.oauth;
	if (!oauth) return undefined;
	const rawHeaders = configuredHeaders(config, configured);
	const authHeader = configured?.authHeader ?? config?.authHeader ?? false;
	return {
		...oauth,
		toAuth: async (credential) => {
			const auth = await oauth.toAuth(credential);
			const env = credential.env;
			const headers = resolveHeadersOrThrow(
				rawHeaders,
				`provider "${providerId}"`,
				typeof env === "object" && env !== null ? (env as Record<string, string>) : undefined,
			);
			return withConfiguredAuth(auth, headers, authHeader);
		},
	};
}

function rawModelHeaders(
	model: Model<Api>,
	config: ModelsJsonProvider | undefined,
	configured: RuntimeProviderConfig | undefined,
): Record<string, string> | undefined {
	const definition = config?.models?.find((entry) => entry.id === model.id);
	const configuredModel = configured?.models?.find((entry) => entry.id === model.id);
	const headers = {
		...config?.modelOverrides?.[model.id]?.headers,
		...definition?.headers,
		...configuredModel?.headers,
	};
	return Object.keys(headers).length > 0 ? headers : undefined;
}

export function validateProviderConfig(
	providerId: string,
	base: Provider | undefined,
	modelsConfig: ModelsJsonProvider | undefined,
	configured: RuntimeProviderConfig,
): void {
	if (configured.streamSimple && !configured.api) {
		throw new Error(`Provider ${providerId}: "api" is required when registering streamSimple.`);
	}
	applyProviderConfig(providerId, applyModelsJson(providerId, base?.getModels() ?? [], modelsConfig), configured);
}

/** Compose built-in and configured provider layers without reading credentials. */
export function composeModelProvider(
	providerId: string,
	base: Provider | undefined,
	modelConfig: ModelConfig,
	configured: RuntimeProviderConfig | undefined,
): Provider {
	const config = modelConfig.getProvider(providerId);
	let oauthCredential: OAuthCredentials | undefined;
	let refreshedModels: RuntimeProviderConfig["models"];
	const currentConfig = (): RuntimeProviderConfig | undefined =>
		configured && refreshedModels ? { ...configured, models: refreshedModels } : configured;
	// models.json modelOverrides are the topmost user-config layer: they apply once,
	// after custom-model upserts and OAuth model projection.
	const getModels = () => {
		let models = applyProviderConfig(
			providerId,
			applyModelsJson(providerId, base?.getModels() ?? [], config),
			currentConfig(),
		);
		if (oauthCredential && configured?.oauth?.modifyModels) {
			models = configured.oauth.modifyModels(models, oauthCredential);
		}
		return models.map((model) => {
			const override = config?.modelOverrides?.[model.id];
			return override ? applyModelOverride(model, override) : model;
		});
	};
	// Validate eagerly so registration/reload reports structural errors immediately.
	getModels();
	const apiKey = composeApiKeyAuth(providerId, base, config, configured);
	const oauth = composeOAuthAuth(providerId, base, config, configured);
	if (!apiKey && !oauth) throw new Error(`Provider ${providerId}: no authentication method configured.`);

	const supportsBaseApi = (model: Model<Api>) => base?.getModels().some((entry) => entry.api === model.api) ?? false;
	const streamWith = (
		model: Model<Api>,
		context: Context,
		options: StreamOptions | undefined,
		simple: boolean,
	): AssistantMessageEventStream =>
		lazyStream(model, async () => {
			if (configured?.streamSimple && model.api === configured.api) {
				return configured.streamSimple(model, context, options as SimpleStreamOptions);
			}
			if (base && supportsBaseApi(model)) {
				return simple
					? base.streamSimple(model, context, options as SimpleStreamOptions)
					: base.stream(model, context, options);
			}
			const api = getApiProvider(model.api);
			if (!api) throw new Error(`No API provider registered for api: ${model.api}`);
			return simple
				? api.streamSimple(model, context, options as SimpleStreamOptions)
				: api.stream(model, context, options);
		});

	return {
		id: providerId,
		name: configured?.name ?? config?.name ?? base?.name ?? configured?.oauth?.name ?? providerId,
		baseUrl: configured?.baseUrl ?? config?.baseUrl ?? base?.baseUrl,
		headers: base?.headers,
		auth: { ...(apiKey ? { apiKey } : {}), ...(oauth ? { oauth } : {}) },
		getModels,
		refreshModels:
			base?.refreshModels || configured?.refreshModels || configured?.oauth?.modifyModels
				? async (context) => {
						await base?.refreshModels?.(context);
						if (configured?.refreshModels) {
							const refreshed = await configured.refreshModels(context);
							if (!context.signal?.aborted) {
								applyProviderConfig(providerId, applyModelsJson(providerId, base?.getModels() ?? [], config), {
									...configured,
									models: refreshed,
								});
								refreshedModels = refreshed;
							}
						}
						oauthCredential = context.credential?.type === "oauth" ? context.credential : undefined;
					}
				: undefined,
		filterModels: base?.filterModels
			? (models, credential: Credential | undefined) => base.filterModels!(models, credential)
			: undefined,
		stream: (model, context, options) => streamWith(model, context, options, false),
		streamSimple: (model, context, options) => streamWith(model, context, options, true),
	};
}

export function resolveConfiguredModelHeaders(
	model: Model<Api>,
	config: ModelsJsonProvider | undefined,
	configured: RuntimeProviderConfig | undefined,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	return resolveHeadersOrThrow(
		rawModelHeaders(model, config, configured),
		`model "${model.provider}/${model.id}"`,
		env,
	);
}

export interface CompatibilityRequestConfig {
	headers?: ProviderHeaders;
	authHeader: boolean;
}

export function resolveCompatibilityRequestConfig(
	model: Model<Api>,
	config: ModelsJsonProvider | undefined,
	runtimeConfig: RuntimeProviderConfig | undefined,
): CompatibilityRequestConfig {
	const resolvedHeaders = resolveHeadersOrThrow(
		{ ...configuredHeaders(config, runtimeConfig), ...rawModelHeaders(model, config, runtimeConfig) },
		`model "${model.provider}/${model.id}"`,
	);
	return {
		headers: model.headers || resolvedHeaders ? { ...model.headers, ...resolvedHeaders } : undefined,
		authHeader: runtimeConfig?.authHeader ?? config?.authHeader ?? false,
	};
}

export function configuredRequestAuthStatus(
	config: ModelsJsonProvider | undefined,
	configured: RuntimeProviderConfig | undefined,
): AuthStatus | undefined {
	const value = configuredApiKey(config, configured);
	if (value === undefined) return undefined;
	if (isCommandConfigValue(value)) return { configured: true, source: "models_json_command" };
	const names = getConfigValueEnvVarNames(value);
	if (names.length > 0) {
		return isConfigValueConfigured(value)
			? { configured: true, source: "environment", label: names.join(", ") }
			: { configured: false };
	}
	return { configured: true, source: configured?.apiKey !== undefined ? "fallback" : "models_json_key" };
}
