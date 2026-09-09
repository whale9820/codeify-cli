import { afterEach, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-responses.ts";
import type { Model } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "test",
	name: "test",
	provider: "codeify",
	api: "openai-responses",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it("retains malformed SSE payloads in diagnostics without dumping them to the console", async () => {
	vi.stubEnv("OPENAI_LOG", "warn");
	const payload = `{"text":"${"payload".repeat(4000)}`;
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(`event: response.output_text.delta\ndata: ${payload}\n\n`, {
			headers: { "content-type": "text/event-stream" },
		}),
	);
	const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
	const result = await stream(model, { messages: [] }, { apiKey: "test", maxRetries: 0 }).result();
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain("Unterminated string");
	expect(errorLog).not.toHaveBeenCalled();
	expect(
		result.diagnostics?.some(
			(entry) => entry.type === "malformed_json_payload" && entry.error?.message.includes(payload),
		),
	).toBe(true);
});
