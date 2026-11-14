import { getBuiltinModels, getBuiltinProviders } from "codeify-ai/providers/all";

export type ModelLimits = { contextWindow: number | null; maxTokens: number | null };

type VersionedLimits = { minor: number[]; limits: ModelLimits };

function versionedFamily(id: string): { family: string; minor: number[] } | undefined {
	// Keep the namespace, major version, and variant intact; only compare dotted revisions.
	const match = /^(.*?[a-z-])([0-9]+)((?:\.[0-9]+)*)(-[a-z0-9][a-z0-9._-]*)?$/u.exec(id);
	if (!match) return undefined;
	return {
		family: `${match[1]}${match[2]}${match[4] ?? ""}`,
		minor: match[3] ? match[3].slice(1).split(".").map(Number) : [],
	};
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const difference = (a[i] ?? 0) - (b[i] ?? 0);
		if (difference) return difference;
	}
	return 0;
}

export function indexModelLimits(models: Iterable<ModelLimits & { id: string }>) {
	const exact = new Map<string, ModelLimits>();
	for (const { id, contextWindow, maxTokens } of models) {
		if (contextWindow === null && maxTokens === null) continue;
		const key = id.toLowerCase();
		const existing = exact.get(key);
		// If providers disagree on a bundled limit, use the lower estimate.
		exact.set(key, {
			contextWindow:
				contextWindow === null
					? (existing?.contextWindow ?? null)
					: Math.min(contextWindow, existing?.contextWindow ?? Infinity),
			maxTokens:
				maxTokens === null ? (existing?.maxTokens ?? null) : Math.min(maxTokens, existing?.maxTokens ?? Infinity),
		});
	}
	const families = new Map<string, VersionedLimits[]>();
	for (const [id, limits] of exact) {
		const version = versionedFamily(id);
		if (!version) continue;
		const versions = families.get(version.family) ?? [];
		versions.push({ minor: version.minor, limits });
		families.set(version.family, versions);
	}
	for (const versions of families.values()) versions.sort((a, b) => compareVersions(b.minor, a.minor));
	return { exact, families };
}

type ModelLimitIndex = ReturnType<typeof indexModelLimits>;
let bundledLimits: ModelLimitIndex | undefined;

function* olderLimits(id: string, index: ModelLimitIndex | undefined): Generator<ModelLimits> {
	const version = versionedFamily(id);
	if (!version || version.minor.length === 0) return;
	for (const candidate of index?.families.get(version.family) ?? []) {
		if (compareVersions(candidate.minor, version.minor) < 0) yield candidate.limits;
	}
}

export function inferModelLimits(id: string, declared: ModelLimits, live?: ModelLimitIndex): ModelLimits {
	let { contextWindow, maxTokens } = declared;
	if (contextWindow !== null && maxTokens !== null) return declared;
	bundledLimits ??= indexModelLimits(
		getBuiltinProviders().flatMap((provider) =>
			getBuiltinModels(provider).map(({ id, contextWindow, maxTokens }) => ({
				id: id.split("/").at(-1) ?? id,
				contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null,
				maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : null,
			})),
		),
	);
	const key = id.toLowerCase();
	const slug = key.split("/").at(-1) ?? key;
	for (const limits of [
		bundledLimits.exact.get(slug),
		...olderLimits(key, live),
		...olderLimits(slug, bundledLimits),
	]) {
		if (!limits) continue;
		contextWindow ??= limits.contextWindow;
		maxTokens ??= limits.maxTokens;
		if (contextWindow !== null && maxTokens !== null) break;
	}
	return { contextWindow, maxTokens };
}
