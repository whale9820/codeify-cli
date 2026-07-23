import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Context, Model, ModelsSimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type CodeifyModelToolRuntime, createCodeifyModelToolDefinition } from "../src/core/tools/codeify-model.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { createFauxStreamFn, createHarness, type FauxResponseInput } from "./test-harness.ts";

const usage: Usage = {
	input: 120,
	output: 30,
	cacheRead: 10,
	cacheWrite: 0,
	totalTokens: 160,
	cost: { input: 0.000006, output: 0.000012, cacheRead: 0.00000005, cacheWrite: 0, total: 0.00001805 },
};

function model(
	id: string,
	options: { vision?: boolean; reasoning?: boolean; inputCost?: number; outputCost?: number } = {},
): Model<"openai-responses"> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: "codeify",
		baseUrl: "https://codeify.test/v1",
		reasoning: options.reasoning ?? true,
		thinkingLevelMap: options.reasoning === false ? { off: null } : { off: "none", low: "low", high: "high" },
		input: options.vision === false ? ["text"] : ["text", "image"],
		cost: {
			input: options.inputCost ?? 1,
			output: options.outputCost ?? 2,
			cacheRead: 0.1,
			cacheWrite: 1.25,
		},
		contextWindow: 200_000,
		maxTokens: 32_000,
	};
}

function runtimeWith(
	models: readonly Model<"openai-responses">[],
	responses: FauxResponseInput[] = [{ text: "delegated answer", usage }],
	onStream?: (model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions) => void,
): { runtime: CodeifyModelToolRuntime; contexts: Context[] } {
	const faux = createFauxStreamFn(responses);
	return {
		runtime: {
			getAvailable: async (providerId) => {
				expect(providerId).toBe("codeify");
				return models;
			},
			streamSimple: (selected, context, options) => {
				onStream?.(selected, context, options);
				return faux.streamFn(selected, context, options);
			},
		},
		contexts: faux.state.contexts,
	};
}

const readSchema = Type.Object({ path: Type.String() });
type ReadInput = Static<typeof readSchema>;

function readTool(
	execute: (input: ReadInput) => Promise<string> = vi.fn(async (_input: ReadInput) => "file contents"),
): AgentTool<typeof readSchema> {
	return {
		name: "read",
		label: "read",
		description: "Read a file",
		parameters: readSchema,
		execute: async (_toolCallId, input) => ({
			content: [{ type: "text", text: await execute(input) }],
			details: {},
		}),
	};
}

const writeSchema = Type.Object({ path: Type.String(), content: Type.String() });

function writeTool(
	execute: (input: Static<typeof writeSchema>) => Promise<void> = vi.fn(async () => undefined),
): AgentTool<typeof writeSchema> {
	return {
		name: "write",
		label: "write",
		description: "Write a file",
		parameters: writeSchema,
		execute: async (_toolCallId, input) => {
			await execute(input);
			return { content: [{ type: "text", text: "wrote file" }], details: {} };
		},
	};
}

const tempDirs: string[] = [];

beforeAll(() => initTheme("dark"));

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("codeify_model tool", () => {
	it("lists other models by price with capability and delegated tool details", async () => {
		const main = model("main", { inputCost: 5, outputCost: 30 });
		const cheapVision = model("cheap-vision", { inputCost: 0.05, outputCost: 0.4 });
		const textOnly = model("text-only", { vision: false, inputCost: 0, outputCost: 0 });
		const { runtime } = runtimeWith([main, cheapVision, textOnly]);
		const tool = createCodeifyModelToolDefinition(process.cwd(), runtime, {
			getDelegatedToolNames: () => ["read", "write"],
		});

		const result = await tool.execute("list", { action: "list", capability: "vision" }, undefined, undefined, {
			cwd: process.cwd(),
			model: main,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("cheap-vision");
		expect(text).toContain("input:0.05 output:0.4");
		expect(text).toContain("computer, read, write");
		expect(text).not.toContain("text-only");
		expect(text).not.toMatch(/^- main /mu);
		expect(result.details).toEqual({ action: "list", count: 1, toolNames: ["computer", "read", "write"] });
	});

	it("runs a delegated model as a multi-turn agent with explicitly granted tools", async () => {
		const main = model("main");
		const cheap = model("cheap");
		const executeRead = vi.fn(async () => "important result");
		const { runtime, contexts } = runtimeWith(
			[main, cheap],
			[
				{ toolCalls: [{ name: "read", args: { path: "notes.txt" } }], usage },
				{ text: "delegated answer", usage },
			],
			(_selected, context, options) => {
				expect(options?.apiKey).toBeUndefined();
				expect(context.systemPrompt).toContain("fully agentic delegated Codeify coding agent");
				expect(context.systemPrompt).toContain("Only inspect notes.txt");
			},
		);
		const tool = createCodeifyModelToolDefinition(process.cwd(), runtime, {
			getDelegatedToolNames: () => ["read"],
			createDelegatedTools: () => ({ tools: [readTool(executeRead)] }),
		});

		const result = await tool.execute(
			"run",
			{
				action: "run",
				model: "cheap",
				task: "Inspect the notes",
				allowedTools: ["read"],
				restrictions: "Only inspect notes.txt",
				reasoningEffort: "low",
				maxOutputTokens: 900,
			},
			undefined,
			undefined,
			{ cwd: process.cwd(), model: main },
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(executeRead).toHaveBeenCalledOnce();
		expect(contexts).toHaveLength(2);
		expect(contexts[0]?.tools?.map((entry) => entry.name)).toEqual(["read"]);
		expect(contexts[1]?.messages.some((message) => message.role === "toolResult")).toBe(true);
		expect(text).toContain("Delegated agent: cheap");
		expect(text).toContain("delegated answer");
		expect(result.details).toMatchObject({
			action: "run",
			status: "completed",
			turns: 2,
			toolCalls: 1,
			completedToolCalls: 1,
			allowedTools: ["read"],
		});
		expect(result.usage?.input).toBe(240);
	});

	it("defaults to read-only tools and never exposes recursive delegation", async () => {
		const main = model("main");
		const cheap = model("cheap");
		const recursive = { ...readTool(), name: "codeify_model", label: "codeify_model" } as unknown as AgentTool;
		const { runtime, contexts } = runtimeWith([main, cheap]);
		const tool = createCodeifyModelToolDefinition(process.cwd(), runtime, {
			createDelegatedTools: () => ({ tools: [readTool(), writeTool(), recursive] }),
		});

		await tool.execute("run", { action: "run", model: "cheap", task: "Inspect" }, undefined, undefined, {
			cwd: process.cwd(),
			model: main,
		});

		expect(contexts[0]?.tools?.map((entry) => entry.name)).toEqual(["read"]);
	});

	it("enforces the delegated tool-call limit", async () => {
		const main = model("main");
		const cheap = model("cheap");
		const executeRead = vi.fn(async () => "ok");
		const { runtime, contexts } = runtimeWith(
			[main, cheap],
			[
				{
					toolCalls: [
						{ name: "read", args: { path: "one.txt" } },
						{ name: "read", args: { path: "two.txt" } },
					],
				},
				"done",
			],
		);
		const tool = createCodeifyModelToolDefinition(process.cwd(), runtime, {
			createDelegatedTools: () => ({ tools: [readTool(executeRead)] }),
		});

		await tool.execute(
			"limited",
			{ action: "run", model: "cheap", task: "Read", allowedTools: ["read"], maxToolCalls: 1 },
			undefined,
			undefined,
			{ cwd: process.cwd(), model: main },
		);

		expect(executeRead).toHaveBeenCalledOnce();
		const toolResults = contexts[1]?.messages.filter((message) => message.role === "toolResult") ?? [];
		expect(toolResults).toHaveLength(2);
		expect(toolResults.some((message) => message.role === "toolResult" && message.isError)).toBe(true);
	});

	it("forces a final synthesis turn at the delegated turn limit", async () => {
		const main = model("main");
		const cheap = model("cheap");
		const executeRead = vi.fn(async () => "ok");
		const { runtime, contexts } = runtimeWith(
			[main, cheap],
			[{ toolCalls: [{ name: "read", args: { path: "one.txt" } }] }, "final summary"],
		);
		const tool = createCodeifyModelToolDefinition(process.cwd(), runtime, {
			createDelegatedTools: () => ({ tools: [readTool(executeRead)] }),
		});

		const result = await tool.execute(
			"turn-limit",
			{ action: "run", model: "cheap", task: "Read", allowedTools: ["read"], maxTurns: 2 },
			undefined,
			undefined,
			{ cwd: process.cwd(), model: main },
		);

		expect(contexts).toHaveLength(2);
		expect(contexts[1]?.tools).toEqual([]);
		expect(contexts[1]?.systemPrompt).toContain("final turn");
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("final summary") });
	});

	it("loads bounded image paths for vision delegation", async () => {
		const directory = await mkdtemp(join(tmpdir(), "codeify-model-tool-"));
		tempDirs.push(directory);
		const imagePath = join(directory, "pixel.png");
		writeFileSync(
			imagePath,
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
				"base64",
			),
		);
		const main = model("main");
		const vision = model("vision");
		const { runtime } = runtimeWith([main, vision], ["one pixel"], (_selected, context) => {
			const message = context.messages[0];
			expect(message?.role).toBe("user");
			if (message?.role !== "user" || !Array.isArray(message.content)) throw new Error("Missing content");
			expect(message.content.some((item) => item.type === "image" && item.mimeType === "image/png")).toBe(true);
		});
		const tool = createCodeifyModelToolDefinition(directory, runtime);

		await tool.execute(
			"vision",
			{ action: "run", model: "vision", task: "Describe it", imagePaths: ["pixel.png"] },
			undefined,
			undefined,
			{ cwd: directory, model: main },
		);
	});

	it("requires an explicit computer domain policy", async () => {
		const main = model("main");
		const cheap = model("cheap");
		const computer = { ...readTool(), name: "computer", label: "computer" } as unknown as AgentTool;
		const { runtime } = runtimeWith([main, cheap]);
		const tool = createCodeifyModelToolDefinition(process.cwd(), runtime, {
			createDelegatedTools: () => ({ tools: [computer] }),
		});

		await expect(
			tool.execute(
				"computer",
				{ action: "run", model: "cheap", task: "Browse", allowedTools: ["computer"] },
				undefined,
				undefined,
				{ cwd: process.cwd(), model: main },
			),
		).rejects.toThrow("computerAccess.allowedDomains");
	});

	it("rejects delegation to the main model", async () => {
		const main = model("main");
		const { runtime } = runtimeWith([main]);
		const tool = createCodeifyModelToolDefinition(process.cwd(), runtime);

		await expect(
			tool.execute("run-main", { action: "run", model: "main", task: "Do work" }, undefined, undefined, {
				cwd: process.cwd(),
				model: main,
			}),
		).rejects.toThrow("other than the main model");
	});

	it("redacts provider failures that could contain a credential", async () => {
		const main = model("main");
		const cheap = model("cheap");
		const { runtime } = runtimeWith([main, cheap], [{ error: "Authorization: Bearer secret-codeify-key" }]);
		const tool = createCodeifyModelToolDefinition(process.cwd(), runtime);

		const request = tool.execute(
			"failure",
			{ action: "run", model: "cheap", task: "Do work" },
			undefined,
			undefined,
			{ cwd: process.cwd(), model: main },
		);
		await expect(request).rejects.toThrow("Delegated Codeify agent request failed.");
		await expect(request).rejects.not.toThrow("secret-codeify-key");
		expect(JSON.stringify(tool.parameters)).not.toContain("apiKey");
	});

	it("redacts model discovery failures that could contain a credential", async () => {
		const main = model("main");
		const runtime: CodeifyModelToolRuntime = {
			getAvailable: async () => {
				throw new Error("Authorization: Bearer secret-discovery-key");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
		};
		const tool = createCodeifyModelToolDefinition(process.cwd(), runtime);

		const request = tool.execute("list-failure", { action: "list" }, undefined, undefined, {
			cwd: process.cwd(),
			model: main,
		});
		await expect(request).rejects.toThrow("Unable to load delegated Codeify models.");
		await expect(request).rejects.not.toThrow("secret-discovery-key");
	});

	it("limits concurrent delegated agents", async () => {
		const main = model("main");
		const cheap = model("cheap");
		const { runtime } = runtimeWith([main, cheap], [{ text: "done", delayMs: 100 }]);
		const tool = createCodeifyModelToolDefinition(process.cwd(), runtime);
		const context = { cwd: process.cwd(), model: main };
		const first = tool.execute(
			"first",
			{ action: "run", model: "cheap", task: "First" },
			undefined,
			undefined,
			context,
		);
		const second = tool.execute(
			"second",
			{ action: "run", model: "cheap", task: "Second" },
			undefined,
			undefined,
			context,
		);

		await expect(
			tool.execute("third", { action: "run", model: "cheap", task: "Third" }, undefined, undefined, context),
		).rejects.toThrow("At most 2 delegated Codeify agents");
		await Promise.all([first, second]);
	});

	it("cancels before starting a delegated agent", async () => {
		const main = model("main");
		const cheap = model("cheap");
		const { runtime } = runtimeWith([main, cheap]);
		const tool = createCodeifyModelToolDefinition(process.cwd(), runtime);
		const controller = new AbortController();
		controller.abort();

		await expect(
			tool.execute("cancelled", { action: "run", model: "cheap", task: "Work" }, controller.signal, undefined, {
				cwd: process.cwd(),
				model: main,
			}),
		).rejects.toThrow("cancelled");
	});

	it("renders meaningful call and result details", () => {
		const main = model("main");
		const cheap = model("cheap");
		const { runtime } = runtimeWith([main, cheap]);
		const tool = createCodeifyModelToolDefinition(process.cwd(), runtime);
		const renderContext = {
			args: { action: "run" as const, model: "cheap", task: "Inspect files", allowedTools: ["read"] },
			toolCallId: "render",
			invalidate: () => {},
			lastComponent: undefined,
			state: {},
			cwd: process.cwd(),
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			showImages: true,
			isError: false,
		};
		const call = tool.renderCall?.(renderContext.args, theme, renderContext).render(160).join("\n") ?? "";
		const result =
			tool
				.renderResult?.(
					{
						content: [{ type: "text", text: "Delegated agent: cheap\n\ndone" }],
						details: {
							action: "run",
							model: "cheap",
							status: "completed",
							turns: 2,
							toolCalls: 1,
							completedToolCalls: 1,
							allowedTools: ["read"],
							filesChanged: [],
							stopReason: "stop",
							usage,
						},
					},
					{ expanded: false, isPartial: false },
					theme,
					renderContext,
				)
				.render(160)
				.join("\n") ?? "";

		expect(call).toContain("delegate cheap");
		expect(call).toContain("read");
		expect(result).toContain("completed");
		expect(result).toContain("2 turns");
		expect(result).toContain("1/1 tools");
	});

	it("appears only while smart model usage is enabled", async () => {
		const harness = await createHarness({ settings: { smartModelUsage: false } });
		try {
			expect(harness.session.getActiveToolNames()).not.toContain("codeify_model");
			harness.session.setSmartModelUsageEnabled(true);
			expect(harness.session.getActiveToolNames()).toContain("codeify_model");
			expect(harness.session.systemPrompt).toContain("fully agentic Codeify model");
			expect(harness.session.systemPrompt).toContain("recommended for menial");
			harness.session.setSmartModelUsageEnabled(false);
			expect(harness.session.getActiveToolNames()).not.toContain("codeify_model");
			expect(harness.session.getAllTools().map((entry) => entry.name)).not.toContain("codeify_model");
		} finally {
			harness.cleanup();
		}
	});
});
