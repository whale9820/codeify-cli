import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	CODEIFY_PROVIDER_ID,
	type CodeifyCatalogModel,
	type CodeifyModel,
	type CodeifyModelDefinition,
	routeModels,
	toModelDefinition,
} from "./codeify-provider.ts";
import { getModelsDevCatalog, inheritModelsDevMetadata } from "./models-dev.ts";
import type { RuntimeProviderConfig } from "./provider-composer.ts";

export const OVERRIDE_PROVIDER_PREFIX = "override-";
export const OVERRIDE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;

export interface OverrideBackend {
	name: string;
	baseUrl: string;
	apiKey: string;
	models: CodeifyCatalogModel[];
}

interface OverrideFile {
	backends: OverrideBackend[];
}

export interface ProbeResult {
	ok: boolean;
	models: CodeifyCatalogModel[];
	error?: string;
}

export function overrideProviderId(name: string): string {
	return `${OVERRIDE_PROVIDER_PREFIX}${name.toLowerCase()}`;
}

export function normalizeBaseUrl(input: string): string | undefined {
	const trimmed = input.trim().replace(/\/+$/u, "");
	try {
		const url = new URL(trimmed);
		return url.protocol === "http:" || url.protocol === "https:" ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

export function validateOverrideName(
	name: string,
	existing: readonly OverrideBackend[],
	current?: string,
): string | undefined {
	if (!OVERRIDE_NAME_PATTERN.test(name))
		return "Name must be 1-32 characters: letters, numbers, dot, dash, underscore.";
	const id = overrideProviderId(name);
	if (name.toLowerCase() === CODEIFY_PROVIDER_ID) return "That name is reserved.";
	if (existing.some((backend) => backend.name !== current && overrideProviderId(backend.name) === id)) {
		return "A backend with that name already exists.";
	}
	return undefined;
}

function escapeConfigValue(value: string): string {
	const escaped = value.replace(/\$/gu, "$$$$");
	return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

/**
 * Keep metadata from known models (possibly inherited from Codeify), but use the
 * current catalog's declared context, including null when no limit is declared.
 */
export function mergeProbedModels(
	existing: readonly CodeifyCatalogModel[],
	probed: readonly CodeifyCatalogModel[],
): CodeifyCatalogModel[] {
	const known = new Map(existing.map((model) => [model.id, model]));
	return probed.map((model) => {
		const previous = known.get(model.id);
		return previous ? { ...previous, contextWindow: model.contextWindow } : model;
	});
}

function matchCodeifyModel(
	id: string,
	codeifyModels: readonly CodeifyModelDefinition[],
): CodeifyModelDefinition | undefined {
	const exact = id.toLowerCase();
	const slug = exact.slice(exact.lastIndexOf("/") + 1);
	for (const key of new Set([exact, slug, slug.replace(/-\d{4,8}$/u, "")])) {
		const matches = codeifyModels.filter((model) => model.id.toLowerCase() === key);
		if (matches.length > 0) return matches.length === 1 ? matches[0] : undefined;
	}
	return undefined;
}

export async function resolveOverrideMetadata(
	models: readonly CodeifyCatalogModel[],
	getCodeifyModels?: () => readonly CodeifyModelDefinition[],
	signal?: AbortSignal,
): Promise<CodeifyCatalogModel[]> {
	const codeifyModels = getCodeifyModels?.() ?? [];
	const modelsDev =
		models.some((model) => !matchCodeifyModel(model.id, codeifyModels)) && !signal?.aborted
			? await getModelsDevCatalog()
			: undefined;
	const latestCodeifyModels = getCodeifyModels?.() ?? codeifyModels;
	return models.map((definition) => {
		const inherited = matchCodeifyModel(definition.id, latestCodeifyModels);
		if (!inherited) return modelsDev ? inheritModelsDevMetadata(definition, modelsDev) : definition;
		return {
			...definition,
			reasoning: inherited.reasoning,
			thinkingLevelMap: inherited.thinkingLevelMap,
			thinkingLevels: inherited.thinkingLevels,
			input: inherited.input,
			cost: inherited.cost,
			contextWindow:
				definition.contextWindow ?? (inherited.knownContextWindow === null ? null : inherited.contextWindow),
			maxTokens: inherited.maxTokens,
			compat: inherited.compat,
		};
	});
}

/**
 * Build the runtime provider config for an override backend. When `store` is given, refreshing
 * the model catalog queries the backend's own GET /models and persists the result.
 */
export function overrideProviderConfig(
	backend: OverrideBackend,
	store?: OverrideStore,
	codeifyModels?: () => readonly CodeifyModelDefinition[],
): RuntimeProviderConfig {
	return {
		name: backend.name,
		baseUrl: backend.baseUrl,
		api: "openai-responses",
		overrideProtocolFallback: true,
		apiKey: escapeConfigValue(backend.apiKey),
		models: routeModels(backend.models, backend.baseUrl),
		refreshModels: store
			? async (context) => {
					const current = store.get(backend.name);
					// Deleted elsewhere: never write it back.
					if (!current) return [];
					if (!context.allowNetwork) return routeModels(current.models, current.baseUrl);
					const probe = await probeOverrideBackend(current.baseUrl, current.apiKey, context.signal);
					if (!probe.ok) throw new Error(`Could not refresh ${backend.name}: ${probe.error}`);
					const merged = mergeProbedModels(current.models, probe.models);
					const models = await resolveOverrideMetadata(merged, codeifyModels, context.signal);
					context.signal?.throwIfAborted();
					const updated = store.updateModels(backend.name, models);
					return updated ? routeModels(models, updated.baseUrl) : [];
				}
			: undefined,
	};
}

function parseOverrideFile(raw: string): OverrideBackend[] {
	const parsed = JSON.parse(raw) as Partial<OverrideFile>;
	return (parsed.backends ?? []).flatMap((backend) =>
		typeof backend?.name === "string" &&
		typeof backend.baseUrl === "string" &&
		typeof backend.apiKey === "string" &&
		Array.isArray(backend.models)
			? [
					{
						...backend,
						models: (backend.models as Array<string | CodeifyCatalogModel>).map((model) =>
							typeof model === "string" ? toModelDefinition({ id: model }) : model,
						),
					},
				]
			: [],
	);
}

/**
 * Persistent list of override backends. Several Codeify processes share one file, so every read
 * picks up changes made by other processes and every mutation is a read-modify-write against the
 * current file contents. Writes are atomic so a concurrent reader never sees a truncated file.
 */
export class OverrideStore {
	private readonly path: string | undefined;
	private backends: OverrideBackend[] = [];
	private loadedStamp: string | undefined;

	constructor(path?: string) {
		this.path = path;
		this.sync();
	}

	private stamp(): string | undefined {
		if (!this.path) return undefined;
		try {
			const stats = statSync(this.path);
			return `${stats.mtimeMs}:${stats.size}:${stats.ino}`;
		} catch {
			return "missing";
		}
	}

	/** Reload from disk when the file changed. Returns false when the file exists but cannot be parsed. */
	private sync(force = false): boolean {
		if (!this.path) return true;
		const stamp = this.stamp();
		if (!force && stamp === this.loadedStamp) return true;
		if (!existsSync(this.path)) {
			this.backends = [];
			this.loadedStamp = stamp;
			return true;
		}
		try {
			this.backends = parseOverrideFile(readFileSync(this.path, "utf8"));
			this.loadedStamp = stamp;
			return true;
		} catch {
			// Keep the last good in-memory list; do not adopt an empty list from an unreadable file.
			return false;
		}
	}

	private mutate(change: (backends: OverrideBackend[]) => OverrideBackend[]): void {
		if (!this.sync(true) && this.path) {
			// Preserve the unreadable file before replacing it so no backend data is lost for good.
			copyFileSync(this.path, `${this.path}.corrupt-${Date.now()}`);
		}
		this.backends = change([...this.backends]);
		if (!this.path) return;
		mkdirSync(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(temporary, JSON.stringify({ backends: this.backends } satisfies OverrideFile, null, 2), {
			mode: 0o600,
		});
		chmodSync(temporary, 0o600);
		renameSync(temporary, this.path);
		this.loadedStamp = this.stamp();
	}

	list(): readonly OverrideBackend[] {
		this.sync();
		return this.backends;
	}

	get(name: string): OverrideBackend | undefined {
		const id = overrideProviderId(name);
		return this.list().find((backend) => overrideProviderId(backend.name) === id);
	}

	upsert(backend: OverrideBackend, previousName?: string): void {
		const previousId = overrideProviderId(previousName ?? backend.name);
		this.mutate((backends) => {
			const index = backends.findIndex((entry) => overrideProviderId(entry.name) === previousId);
			if (index >= 0) backends[index] = backend;
			else backends.push(backend);
			return backends;
		});
	}

	/**
	 * Replace only the model list of a saved backend, keeping any URL or key edits made elsewhere.
	 * Returns the updated backend, or undefined when it no longer exists (deleted by another process).
	 */
	updateModels(name: string, models: CodeifyCatalogModel[]): OverrideBackend | undefined {
		const id = overrideProviderId(name);
		let updated: OverrideBackend | undefined;
		this.mutate((backends) =>
			backends.map((backend) => {
				if (overrideProviderId(backend.name) !== id) return backend;
				updated = { ...backend, models };
				return updated;
			}),
		);
		return updated;
	}

	remove(name: string): void {
		const id = overrideProviderId(name);
		this.mutate((backends) => backends.filter((backend) => overrideProviderId(backend.name) !== id));
	}
}

function joinUrl(baseUrl: string, path: string): string {
	return `${baseUrl}${path}`;
}

export async function probeOverrideBackend(
	baseUrl: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<ProbeResult> {
	const timeout = AbortSignal.timeout(30_000);
	try {
		const response = await fetch(joinUrl(baseUrl, "/models"), {
			headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		if (!response.ok) {
			const detail = (await response.text()).slice(0, 200).trim();
			return {
				ok: false,
				models: [],
				error: `GET /models returned ${response.status}${detail ? `: ${detail}` : ""}`,
			};
		}
		const payload = (await response.json()) as { data?: CodeifyModel[] };
		if (!Array.isArray(payload.data)) {
			return { ok: false, models: [], error: "GET /models did not return a model list." };
		}
		const models = payload.data
			.filter((entry) => typeof entry.id === "string" && entry.id.length > 0)
			.map(toModelDefinition);
		return { ok: true, models };
	} catch (error) {
		return { ok: false, models: [], error: error instanceof Error ? error.message : String(error) };
	}
}
