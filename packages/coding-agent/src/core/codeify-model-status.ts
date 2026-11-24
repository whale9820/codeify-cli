import { CODEIFY_BASE_URL } from "./codeify-provider.ts";

export type CodeifyModelHealth = "operational" | "degraded" | "unavailable";

const HEALTH_BY_STATUS: Record<string, CodeifyModelHealth> = {
	green: "operational",
	yellow: "degraded",
	red: "unavailable",
};

let lastStatuses: ReadonlyMap<string, CodeifyModelHealth> = new Map();

export function getCachedCodeifyModelStatuses(): ReadonlyMap<string, CodeifyModelHealth> {
	return lastStatuses;
}

export async function fetchCodeifyModelStatuses(
	apiKey: string,
	signal?: AbortSignal,
): Promise<ReadonlyMap<string, CodeifyModelHealth>> {
	const response = await fetch(`${CODEIFY_BASE_URL.replace(/\/v1\/?$/u, "")}/api/model-status`, {
		headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
		signal,
	});
	if (!response.ok) throw new Error(`Codeify model status request failed (${response.status})`);
	const payload = (await response.json()) as { models?: Record<string, { status?: unknown }> };
	const statuses = new Map<string, CodeifyModelHealth>();
	for (const [id, entry] of Object.entries(payload.models ?? {})) {
		const health = typeof entry?.status === "string" ? HEALTH_BY_STATUS[entry.status] : undefined;
		if (health) statuses.set(id, health);
	}
	lastStatuses = statuses;
	return statuses;
}
