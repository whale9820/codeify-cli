import { getSupportedThinkingLevels, type Model, type ModelsStoreEntry } from "codeify-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple as streamCompletions } from "../../ai/src/api/openai-completions.ts";
import { streamSimple as streamResponses } from "../../ai/src/api/openai-responses.ts";
import {
	applyEntryToMaterializedState,
	createEmptyMaterializedState,
	materializedStateFromRows,
	serializeSummary,
} from "../../storage/sqlite-node/src/sqlite/storage/session-materialized.ts";
import { parseArgs } from "../src/cli/args.ts";
import { CODEIFY_BASE_URL, codeifyProvider, toModelDefinition } from "../src/core/codeify-provider.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { parseModelPattern } from "../src/core/model-resolver.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

afterEach(() => vi.restoreAllMocks());

const efforts = ["instant", "low", "maximum", "extra-high", "future-effort"];

function mercuryModel(): Model<"openai-completions"> {
	return {
		...toModelDefinition({ id: "mercury-3", reasoning_efforts: efforts }),
		api: "openai-completions",
		provider: "codeify",
		baseUrl: CODEIFY_BASE_URL,
	};
}

describe("server-provided reasoning efforts", () => {
	it("keeps exact effort names and order in live and offline composed catalogs", async () => {
		let stored: ModelsStoreEntry | undefined;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ data: [{ id: "mercury-3", reasoning_efforts: efforts }] })),
		);
		const store = {
			read: async () => stored,
			write: async (entry: ModelsStoreEntry) => {
				stored = entry;
			},
			delete: async () => {},
		};
		for (const allowNetwork of [true, false]) {
			const provider = composeModelProvider(
				"codeify",
				undefined,
				await ModelConfig.load(undefined),
				codeifyProvider(),
			);
			await provider.refreshModels!({ credential: { type: "api_key", key: "test" }, store, allowNetwork });
			const model = provider.getModels()[0];
			expect(getSupportedThinkingLevels(model)).toEqual(efforts);
			expect(model.thinkingLevelMap?.instant).toBe("instant");
		}
	});

	it("accepts instant in CLI flags and model suffixes", () => {
		expect(parseArgs(["--thinking", "instant"]).thinking).toBe("instant");
		expect(parseModelPattern("mercury-3:instant", [mercuryModel()])).toMatchObject({
			thinkingLevel: "instant",
			warning: undefined,
		});
	});

	it("renders and preselects instant in the thinking selector", () => {
		initTheme("dark");
		const selector = new ThinkingSelectorComponent(
			"instant",
			getSupportedThinkingLevels(mercuryModel()),
			() => {},
			() => {},
		);
		expect(selector.getSelectList().getSelectedItem()?.value).toBe("instant");
		const rendered = selector.render(100).join("\n");
		for (const effort of efforts) expect(rendered).toContain(effort);
	});

	it("persists custom efforts in materialized session summaries", () => {
		const state = createEmptyMaterializedState();
		applyEntryToMaterializedState(state, {
			type: "thinking_level_change",
			id: "effort",
			parentId: null,
			timestamp: new Date().toISOString(),
			thinkingLevel: "instant",
		});
		const restored = materializedStateFromRows({ session_id: "session", payload: serializeSummary(state) }, []);
		expect(restored.currentThinkingLevel).toBe("instant");
	});

	it.each(efforts)("sends %s unchanged through Chat Completions", async (reasoning) => {
		let body: Record<string, unknown> | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
				headers: { "content-type": "text/event-stream" },
			});
		});
		const result = await streamCompletions(mercuryModel(), { messages: [] }, { apiKey: "test", reasoning }).result();
		expect(result.stopReason).toBe("stop");
		expect(body?.reasoning_effort).toBe(reasoning);
	});

	it("sends custom efforts unchanged through Responses", async () => {
		let body: Record<string, unknown> | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
		});
		await streamResponses(
			{ ...mercuryModel(), api: "openai-responses" },
			{ messages: [] },
			{
				apiKey: "test",
				reasoning: "instant",
			},
		).result();
		expect(body?.reasoning).toMatchObject({ effort: "instant" });
	});
});
