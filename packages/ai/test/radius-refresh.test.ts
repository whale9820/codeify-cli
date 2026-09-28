import { afterEach, describe, expect, it, vi } from "vitest";
import type { RefreshModelsContext } from "../src/models.ts";
import type { ModelsStoreEntry } from "../src/models-store.ts";
import { radiusProvider } from "../src/providers/radius.ts";

const config = {
	baseUrl: "https://radius.example/v1",
	models: [
		{
			id: "auto",
			name: "Auto",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		},
	],
};

function createContext(): RefreshModelsContext {
	let stored: ModelsStoreEntry | undefined;
	return {
		credential: { type: "api_key", key: "test-key" },
		allowNetwork: true,
		store: {
			read: async () => stored,
			write: async (entry) => {
				stored = entry;
			},
			delete: async () => {
				stored = undefined;
			},
		},
	};
}

afterEach(() => vi.restoreAllMocks());

describe("Radius refresh sequencing", () => {
	it("does not swallow a network refresh queued behind a cache-only refresh", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(config)));
		const provider = radiusProvider({ gateway: "https://radius.example" });
		const context = createContext();

		await Promise.all([
			provider.refreshModels?.({ ...context, allowNetwork: false }),
			provider.refreshModels?.(context),
		]);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(provider.getModels().map((model) => model.id)).toEqual(["auto"]);
		expect((await context.store.read())?.models).toHaveLength(1);
	});

	it("propagates a rejected refresh without leaving an unhandled cleanup promise", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("offline"));
		const provider = radiusProvider({ gateway: "https://radius.example" });
		const context = createContext();

		await expect(provider.refreshModels?.(context)).rejects.toThrow("offline");
		fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(config)));
		await provider.refreshModels?.(context);

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(provider.getModels().map((model) => model.id)).toEqual(["auto"]);
	});

	it("runs a queued refresh after the preceding refresh fails", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce(new Response(JSON.stringify(config)));
		const provider = radiusProvider({ gateway: "https://radius.example" });
		const context = createContext();
		const first = provider.refreshModels?.(context);
		const second = provider.refreshModels?.(context);

		await expect(first).rejects.toThrow("offline");
		await expect(second).resolves.toBeUndefined();
		expect(provider.getModels().map((model) => model.id)).toEqual(["auto"]);
	});
});
