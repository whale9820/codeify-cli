import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCodeifyModelStatuses, getCachedCodeifyModelStatuses } from "../src/core/codeify-model-status.ts";

describe("fetchCodeifyModelStatuses", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("maps status colors to health labels and sends the bearer key", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						window_seconds: 3600,
						models: {
							a: { status: "green", minutes: [1, 1] },
							b: { status: "yellow" },
							c: { status: "red" },
							d: { status: "purple" },
						},
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		const statuses = await fetchCodeifyModelStatuses("key-123");

		expect([...statuses]).toEqual([
			["a", "operational"],
			["b", "degraded"],
			["c", "unavailable"],
		]);
		expect(getCachedCodeifyModelStatuses()).toBe(statuses);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toMatch(/\/api\/model-status$/);
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer key-123");
	});

	it("throws on non-ok responses", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("no", { status: 401 })),
		);
		await expect(fetchCodeifyModelStatuses("bad")).rejects.toThrow("401");
	});
});
