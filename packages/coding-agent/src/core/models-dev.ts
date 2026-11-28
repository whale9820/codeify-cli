import { type CodeifyCatalogModel, type CodeifyModel, toModelDefinition } from "./codeify-provider.ts";

type ModelsDevModel = Pick<CodeifyModel, "id" | "limit" | "modalities"> & {
	canonical_model_id?: string;
	reasoning?: boolean;
	reasoning_options?: Array<{ type: string; values?: string[] }>;
};

type Match = { canonical: string; score: number; model: ModelsDevModel };
type ModelsDevIndex = Map<string, Match | null>;
let catalog: { promise: Promise<ModelsDevIndex | undefined>; expires: number } | undefined;

async function fetchModelsDev(): Promise<ModelsDevIndex | undefined> {
	try {
		const response = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(5_000) });
		if (!response.ok) return undefined;
		const providers = (await response.json()) as Record<string, { models?: Record<string, ModelsDevModel> }>;
		const index: ModelsDevIndex = new Map();
		for (const [provider, { models }] of Object.entries(providers)) {
			for (const model of Object.values(models ?? {})) {
				if (typeof model.id !== "string") continue;
				const id = model.id.toLowerCase();
				const canonical = model.canonical_model_id?.toLowerCase() ?? id;
				const lab = canonical.split("/")[0];
				const native = provider === lab || provider.startsWith(`${lab}-`);
				const score =
					(model.reasoning_options?.length ? 4 : 0) +
					(native ? 2 : 0) +
					(model.modalities?.input?.includes("image") ? 1 : 0);
				for (const key of new Set([id, canonical, id.split("/").at(-1)!, canonical.split("/").at(-1)!])) {
					const current = index.get(key);
					if (current === null) continue;
					if (current && current.canonical !== canonical) index.set(key, null);
					else if (!current || score > current.score) index.set(key, { canonical, score, model });
				}
			}
		}
		return index.size > 0 ? index : undefined;
	} catch {
		return undefined;
	}
}

export function getModelsDevCatalog(): Promise<ModelsDevIndex | undefined> {
	if (catalog && Date.now() < catalog.expires) return catalog.promise;
	const promise = fetchModelsDev();
	catalog = { promise, expires: Date.now() + 4 * 60 * 60 * 1000 };
	void promise.then((index) => {
		if (!index && catalog?.promise === promise) catalog = undefined;
	});
	return promise;
}

export function inheritModelsDevMetadata(definition: CodeifyCatalogModel, index: ModelsDevIndex): CodeifyCatalogModel {
	const id = definition.id.toLowerCase();
	const slug = id.split("/").at(-1)!;
	const undated = id.replace(/-\d{4,8}$/u, "");
	const match = [id, slug, undated, undated.split("/").at(-1)!]
		.map((key) => index.get(key))
		.find((value) => value !== undefined)?.model;
	if (!match) return definition;
	const efforts = match.reasoning_options?.find((option) => option.type === "effort")?.values;
	const toggle = match.reasoning_options?.some((option) => option.type === "toggle");
	const metadata = toModelDefinition({
		...match,
		id: definition.id,
		thinking_levels: efforts?.map((effort) => (effort === "none" ? "off" : effort)) ?? (toggle ? [] : undefined),
		supports_thinking_toggle: toggle,
	});
	const thinking = efforts || toggle || match.reasoning === false;
	return {
		...definition,
		reasoning: match.reasoning ?? definition.reasoning,
		thinkingLevels: thinking ? metadata.thinkingLevels : definition.thinkingLevels,
		thinkingLevelMap: thinking
			? { ...metadata.thinkingLevelMap, ...(efforts?.includes("none") && !toggle ? { off: "none" } : {}) }
			: definition.thinkingLevelMap,
		input: match.modalities?.input?.length ? metadata.input : definition.input,
		contextWindow: definition.contextWindow ?? metadata.contextWindow,
		maxTokens: definition.maxTokens ?? metadata.maxTokens,
	};
}
