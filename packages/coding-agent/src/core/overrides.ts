import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	CODEIFY_PROVIDER_ID,
	type CodeifyModel,
	type CodeifyModelDefinition,
	toModelDefinition,
} from "./codeify-provider.ts";
import type { RuntimeProviderConfig } from "./provider-composer.ts";

export const OVERRIDE_PROVIDER_PREFIX = "override-";
export const OVERRIDE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;

export interface OverrideBackend {
	name: string;
	baseUrl: string;
	apiKey: string;
	models: CodeifyModelDefinition[];
}

interface OverrideFile {
	backends: OverrideBackend[];
}

export interface ProbeResult {
	ok: boolean;
	models: CodeifyModelDefinition[];
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

export function overrideProviderConfig(backend: OverrideBackend): RuntimeProviderConfig {
	return {
		name: backend.name,
		baseUrl: backend.baseUrl,
		api: "openai-responses",
		apiKey: escapeConfigValue(backend.apiKey),
		models: backend.models,
	};
}

export class OverrideStore {
	private readonly path: string | undefined;
	private backends: OverrideBackend[];

	constructor(path?: string) {
		this.path = path;
		this.backends = this.load();
	}

	private load(): OverrideBackend[] {
		if (!this.path || !existsSync(this.path)) return [];
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<OverrideFile>;
			return (parsed.backends ?? []).flatMap((backend) =>
				typeof backend?.name === "string" &&
				typeof backend.baseUrl === "string" &&
				typeof backend.apiKey === "string" &&
				Array.isArray(backend.models)
					? [
							{
								...backend,
								models: (backend.models as Array<string | CodeifyModelDefinition>).map((model) =>
									typeof model === "string" ? toModelDefinition({ id: model }) : model,
								),
							},
						]
					: [],
			);
		} catch {
			return [];
		}
	}

	private save(): void {
		if (!this.path) return;
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, JSON.stringify({ backends: this.backends } satisfies OverrideFile, null, 2), {
			mode: 0o600,
		});
		chmodSync(this.path, 0o600);
	}

	list(): readonly OverrideBackend[] {
		return this.backends;
	}

	get(name: string): OverrideBackend | undefined {
		const id = overrideProviderId(name);
		return this.backends.find((backend) => overrideProviderId(backend.name) === id);
	}

	upsert(backend: OverrideBackend, previousName?: string): void {
		const previousId = overrideProviderId(previousName ?? backend.name);
		const index = this.backends.findIndex((entry) => overrideProviderId(entry.name) === previousId);
		if (index >= 0) this.backends[index] = backend;
		else this.backends.push(backend);
		this.save();
	}

	remove(name: string): void {
		const id = overrideProviderId(name);
		this.backends = this.backends.filter((backend) => overrideProviderId(backend.name) !== id);
		this.save();
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
			.map((entry) => toModelDefinition(entry));
		return { ok: true, models };
	} catch (error) {
		return { ok: false, models: [], error: error instanceof Error ? error.message : String(error) };
	}
}
