import { afterEach, describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import type { Context } from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: 0 }],
};

afterEach(() => vi.unstubAllGlobals());

describe("Anthropic API version", () => {
	it.each(["fake-key", "sk-ant-oat-fake-token"])("uses the current version with credential %s", async (apiKey) => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
				headers: { "content-type": "text/event-stream" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await stream(getModel("anthropic", "claude-sonnet-4-6"), context, {
			apiKey,
			temperature: 0,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(fetchMock).toHaveBeenCalledOnce();
		const request = fetchMock.mock.calls[0][1];
		expect(new Headers(request?.headers).get("anthropic-version")).toBe("2026-10-21");
		const payload = JSON.parse(String(request?.body)) as Record<string, unknown>;
		for (const parameter of ["temperature", "top_p", "top_k"]) {
			expect(payload).not.toHaveProperty(parameter);
		}
	});

	it("uses the provider's existing version and sampling support for compatible endpoints", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
				headers: { "content-type": "text/event-stream" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await stream(
			{
				...getModel("anthropic", "claude-sonnet-4-6"),
				provider: "vendor-proxy",
				baseUrl: "https://example.test/anthropic",
			},
			context,
			{ apiKey: "fake-key", temperature: 0 },
		).result();

		expect(result.stopReason).toBe("stop");
		expect(fetchMock).toHaveBeenCalledOnce();
		const request = fetchMock.mock.calls[0][1];
		expect(new Headers(request?.headers).get("anthropic-version")).toBe("2023-06-01");
		expect(JSON.parse(String(request?.body))).toHaveProperty("temperature", 0);
	});
});
