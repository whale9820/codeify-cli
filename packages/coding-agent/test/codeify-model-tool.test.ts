import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "codeify-agent-core";
import type { Api, Context, Model, ModelsSimpleStreamOptions, Usage } from "codeify-ai";
import { createAssistantMessageEventStream } from "codeify-ai";
import { type Static, Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BackgroundTaskManager, buildCompletionMessage } from "../src/core/background-tasks.ts";
import {
	type CodeifyModelToolRuntime,
	createCodeifyModelToolDefinition,
	createCodeifyModelWorkerDefinition,
} from "../src/core/tools/codeify-model.ts";
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
	vi.useRealTimers();
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("codeify_model tool", () => {
	it("retries upstream errors three times without repeating completed tools or consuming turn budgets", async () => {
		vi.useFakeTimers();
		const selected = model("worker");
		const executeRead = vi.fn(async () => "notes");
		const { runtime, contexts } = runtimeWith(
			[selected],
			[
				{ toolCalls: [{ name: "read", args: { path: "notes.txt" } }] },
				...Array.from({ length: 3 }, () => ({ error: "upstream_error: unexpected EOF", usage })),
				"recovered summary",
			],
		);
		const onOutput = vi.fn();
		const tool = createCodeifyModelWorkerDefinition(process.cwd(), runtime, {
			onOutput,
			createDelegatedTools: () => ({ tools: [readTool(executeRead)] }),
		});
		const request = tool.execute(
			"retry",
			{ action: "run", model: "worker", task: "Read", maxTurns: 2 },
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);
		await vi.runAllTimersAsync();
		const result = await request;
		expect(result.details).toMatchObject({ turns: 2, completedToolCalls: 1, stopReason: "stop" });
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("recovered summary") });
		expect(result.usage?.input).toBe(560);
		expect(executeRead).toHaveBeenCalledOnce();
		expect(contexts).toHaveLength(5);
		for (const context of contexts.slice(1)) {
			expect(context.messages.at(-1)?.role).toBe("toolResult");
			expect(context.tools).toEqual([]);
		}
		expect(onOutput.mock.calls.flat().join("")).toContain("Retrying delegated model (3/3)");
	});

	it("fails after exactly three upstream retries and redacts retry diagnostics", async () => {
		vi.useFakeTimers();
		const { runtime, contexts } = runtimeWith(
			[model("worker")],
			Array.from({ length: 5 }, () => ({ error: "503 upstream_error: api_key=secret-retry" })),
		);
		const onOutput = vi.fn();
		const dispose = vi.fn();
		const tool = createCodeifyModelWorkerDefinition(process.cwd(), runtime, {
			onOutput,
			createDelegatedTools: () => ({ tools: [], dispose }),
		});
		const request = tool.execute(
			"exhausted",
			{ action: "run", model: "worker", task: "Work" },
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);
		const assertion = expect(request).rejects.toThrow("503 upstream_error: api_key=[redacted]");
		await vi.runAllTimersAsync();
		await assertion;
		expect(contexts).toHaveLength(4);
		expect(onOutput.mock.calls.flat().join("")).not.toContain("secret-retry");
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("keeps failed partial messages and tool calls out of later turns", async () => {
		const executeRead = vi.fn(async () => "notes");
		const { runtime, contexts } = runtimeWith(
			[model("worker")],
			[
				{
					text: "Incomplete response",
					toolCalls: [{ name: "read", args: { path: "wrong.txt" } }],
					error: "upstream_error: connection lost",
				},
				{ text: "Recovered", toolCalls: [{ name: "read", args: { path: "notes.txt" } }] },
				"done",
			],
		);
		const onOutput = vi.fn();
		const tool = createCodeifyModelWorkerDefinition(process.cwd(), runtime, {
			onOutput,
			createDelegatedTools: () => ({ tools: [readTool(executeRead)] }),
		});
		await tool.execute("partial", { action: "run", model: "worker", task: "Read" }, undefined, undefined, {
			cwd: process.cwd(),
		});
		expect(executeRead).toHaveBeenCalledExactlyOnceWith({ path: "notes.txt" });
		expect(contexts[2]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(JSON.stringify(contexts[2])).not.toContain("Incomplete response");
		expect(onOutput.mock.calls.flat().join("")).toContain("Assistant:\nRecovered");
	});

	it.each(["401 invalid API key", "insufficient_quota", "context length exceeded"])(
		"does not retry permanent errors: %s",
		async (error) => {
			const { runtime, contexts } = runtimeWith([model("worker")], [{ error }, "unexpected retry"]);
			const tool = createCodeifyModelWorkerDefinition(process.cwd(), runtime);
			await expect(
				tool.execute("permanent", { action: "run", model: "worker", task: "Work" }, undefined, undefined, {
					cwd: process.cwd(),
				}),
			).rejects.toThrow(error);
			expect(contexts).toHaveLength(1);
		},
	);

	it("cancels during retry backoff without another request", async () => {
		const controller = new AbortController();
		const { runtime, contexts } = runtimeWith([model("worker")], [{ error: "503 upstream error" }, "done"]);
		const dispose = vi.fn();
		const tool = createCodeifyModelWorkerDefinition(process.cwd(), runtime, {
			onOutput: (text) => {
				if (text.includes("Retrying delegated model")) controller.abort();
			},
			createDelegatedTools: () => ({ tools: [], dispose }),
		});
		await expect(
			tool.execute("cancel", { action: "run", model: "worker", task: "Work" }, controller.signal, undefined, {
				cwd: process.cwd(),
			}),
		).rejects.toThrow("cancelled");
		expect(contexts).toHaveLength(1);
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("shows model loading, streamed reasoning and text, and tool output before completion", async () => {
		const selected = model("worker");
		const finished = vi.fn();
		const backgroundTasks = new BackgroundTaskManager(finished);
		let load!: (models: Model<"openai-responses">[]) => void;
		let finishRead!: () => void;
		let startRead!: () => void;
		let resumeStream!: () => void;
		const pendingStream = new Promise<void>((resolve) => {
			resumeStream = resolve;
		});
		const loading = new Promise<Model<"openai-responses">[]>((resolve) => {
			load = resolve;
		});
		const pendingRead = new Promise<void>((resolve) => {
			finishRead = resolve;
		});
		const startedRead = new Promise<void>((resolve) => {
			startRead = resolve;
		});
		const { runtime } = runtimeWith(
			[selected],
			[
				{
					thinking: "Inspecting the project\napi_key=secret-reasoning\n",
					text: "Reading notes\nAuthorization: Bearer secret-text\n",
					toolCalls: [{ name: "read", args: { path: "notes.txt" } }],
				},
				"done",
			],
		);
		runtime.getAvailable = () => loading;
		const streamSimple = runtime.streamSimple;
		runtime.streamSimple = (model, context, options) => {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				for await (const event of streamSimple(model, context, options)) {
					stream.push(event);
					if (
						event.type === "text_delta" &&
						event.partial.content.some((block) => block.type === "text" && block.text.includes("Reading notes\n"))
					) {
						await pendingStream;
					}
				}
			})();
			return stream;
		};
		const tool = createCodeifyModelToolDefinition(process.cwd(), runtime, {
			backgroundTasks,
			createDelegatedTools: () => ({
				tools: [
					{
						...readTool(),
						execute: async (_id, _args, _signal, onUpdate) => {
							onUpdate?.({
								content: [{ type: "text", text: "Reading first section\napi_key=secret-tool\n" }],
								details: {},
							});
							startRead();
							await pendingRead;
							return { content: [{ type: "text", text: "notes" }], details: {} };
						},
					},
				],
			}),
		});
		try {
			await tool.execute("spawn", { action: "run", model: "worker", task: "Read" }, undefined, undefined, {
				cwd: process.cwd(),
			});
			expect(backgroundTasks.readOutput("bg1")?.text).toContain("Loading delegated model: worker");
			load([selected]);
			await vi.waitFor(() =>
				expect(backgroundTasks.readOutput("bg1")?.text).toContain("Assistant:\nReading notes\n"),
			);
			expect(backgroundTasks.readOutput("bg1")?.text).not.toContain("Tool read started");
			resumeStream();
			await startedRead;
			const output = backgroundTasks.readOutput("bg1")!.text;
			expect(output).toContain("Turn 1: waiting for worker");
			expect(output).toContain("Thinking:\nInspecting the project");
			expect(output).toContain("Assistant:\nReading notes");
			expect(output).toContain("Preparing tool call");
			expect(output).toContain("Tool read output:\nReading first section");
			expect(output).not.toMatch(/secret-(reasoning|text|tool)/u);
			expect(backgroundTasks.get("bg1")?.status).toBe("running");
			expect(finished).not.toHaveBeenCalled();
			finishRead();
			await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
		} finally {
			load([selected]);
			resumeStream();
			finishRead();
			backgroundTasks.detach();
		}
	});

	it.each(["codeify_model", "background_task"])(
		"keeps the parent working and delivers one completion through %s",
		async (toolName) => {
			const selected = model("worker");
			let finish!: () => void;
			const pending = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const harness = await createHarness({
				settings: { smartModelUsage: true },
				responses: [
					{
						toolCalls: [
							{
								name: toolName,
								args: {
									action: toolName === "codeify_model" ? "run" : "start",
									model: "worker",
									task: "Work",
									allowedTools: [],
								},
							},
						],
					},
					"Independent work",
					"Reviewed delegated result",
				],
			});
			const delegated = createFauxStreamFn([{ text: "delegated answer", usage }]);
			vi.spyOn(harness.session.modelRuntime, "getAvailable").mockResolvedValue([selected]);
			vi.spyOn(harness.session.modelRuntime, "streamSimple").mockImplementation((model, context, options) => {
				const stream = createAssistantMessageEventStream();
				void pending.then(async () => {
					for await (const event of delegated.streamFn(model, context, options)) stream.push(event);
				});
				return stream;
			});
			let continued = false;
			harness.session.subscribe((event) => {
				if (
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					event.message.content.some((block) => block.type === "text" && block.text === "Independent work")
				) {
					continued = true;
					expect(harness.session.getBackgroundTasks()).toMatchObject([{ kind: "agent", status: "running" }]);
					finish();
				}
			});
			try {
				await harness.session.prompt("Delegate and continue working");
				expect(continued).toBe(true);
				expect(harness.session.getBackgroundTasks()).toHaveLength(1);
				expect(harness.session.getBackgroundTasks()[0].status).toBe("completed");
				expect(
					harness.session.messages.filter(
						(message) => message.role === "custom" && message.customType === "background_task",
					),
				).toHaveLength(1);
				expect(harness.session.getLastAssistantText()).toBe("Reviewed delegated result");
				expect(harness.session.getSessionStats().tokens.input).toBe(420);
			} finally {
				finish();
				harness.cleanup();
			}
		},
	);

	it("returns before delegated tools finish and delivers the full result in the background", async () => {
		const selected = model("worker");
		const finished = vi.fn();
		const backgroundTasks = new BackgroundTaskManager(finished);
		let finishRead!: (value: string) => void;
		const pendingRead = new Promise<string>((resolve) => {
			finishRead = resolve;
		});
		let startRead!: () => void;
		const startedRead = new Promise<void>((resolve) => {
			startRead = resolve;
		});
		const dispose = vi.fn();
		const summary = "result ".repeat(10_000);
		const { runtime } = runtimeWith(
			[selected],
			[
				{ toolCalls: [{ name: "read", args: { path: "notes.txt" } }], usage },
				{ text: summary, usage },
			],
		);
		const tool = createCodeifyModelToolDefinition(process.cwd(), runtime, {
			backgroundTasks,
			createDelegatedTools: () => ({
				tools: [
					readTool(async () => {
						startRead();
						return pendingRead;
					}),
				],
				dispose,
			}),
		});
		const controller = new AbortController();
		try {
			const result = await tool.execute(
				"spawn",
				{ action: "run", model: "worker", task: "Read" },
				controller.signal,
				undefined,
				{ cwd: process.cwd() },
			);
			expect(result.details).toMatchObject({ action: "run", status: "running", taskId: "bg1" });
			await startedRead;
			expect(backgroundTasks.readOutput("bg1")?.text).toContain('Tool read started: {"path":"notes.txt"}');
			controller.abort();
			expect(backgroundTasks.get("bg1")?.status).toBe("running");
			expect(finished).not.toHaveBeenCalled();
			expect(dispose).not.toHaveBeenCalled();
			finishRead("notes");
			await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
			expect(backgroundTasks.get("bg1")).toMatchObject({ status: "completed", usage: { input: 240 } });
			expect(backgroundTasks.readOutput("bg1")?.text).toContain(summary.trim());
			expect(dispose).toHaveBeenCalledOnce();
		} finally {
			finishRead("notes");
			backgroundTasks.detach();
		}
	});

	it("reports background failures without exposing provider credentials", async () => {
		const selected = model("worker");
		const finished = vi.fn();
		const backgroundTasks = new BackgroundTaskManager(finished);
		const { runtime } = runtimeWith([selected], [{ error: "Bearer secret-codeify-key" }]);
		const tool = createCodeifyModelToolDefinition(process.cwd(), runtime, { backgroundTasks });
		await tool.execute("spawn", { action: "run", model: "worker", task: "Work" }, undefined, undefined, {
			cwd: process.cwd(),
		});
		await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
		expect(backgroundTasks.get("bg1")).toMatchObject({
			status: "failed",
			error: expect.stringContaining("Delegated Codeify CLI agent request failed."),
		});
		expect(JSON.stringify(backgroundTasks.list())).not.toContain("secret-codeify-key");
		expect(backgroundTasks.get("bg1")?.error).toContain("[redacted]");
	});

	it("retains delegated progress and tool errors when a later provider request fails", async () => {
		const finished = vi.fn();
		const backgroundTasks = new BackgroundTaskManager(finished);
		const { runtime } = runtimeWith(
			[model("worker")],
			[
				{ text: "Inspecting notes", toolCalls: [{ name: "read", args: { path: "missing.txt" } }] },
				...Array.from({ length: 4 }, () => ({ error: "HTTP 429: rate limit exceeded; api_key=secret-key" })),
			],
		);
		const tool = createCodeifyModelToolDefinition(process.cwd(), runtime, {
			backgroundTasks,
			createDelegatedTools: () => ({
				tools: [
					readTool(async () => {
						throw new Error("ENOENT: missing.txt");
					}),
				],
			}),
		});
		await tool.execute("spawn", { action: "run", model: "worker", task: "Read notes" }, undefined, undefined, {
			cwd: process.cwd(),
		});
		await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce(), { timeout: 10_000 });
		const task = backgroundTasks.get("bg1")!;
		const output = backgroundTasks.readOutput("bg1")!;
		const message = buildCompletionMessage(task, output);
		expect(task.status).toBe("failed");
		expect(message).toContain("HTTP 429: rate limit exceeded");
		expect(message).toContain("Inspecting notes");
		expect(message).toContain("Tool read failed");
		expect(message).toContain("ENOENT: missing.txt");
		expect(message).not.toContain("secret-key");
		expect(message).not.toContain("(no output)");
	});

	it("retains sanitized diagnostics for thrown runtime failures", async () => {
		const { runtime } = runtimeWith([model("worker")]);
		runtime.streamSimple = () => {
			throw new Error("Connection refused https://user:secret-password@example.test/v1?access_token=secret-token");
		};
		const tool = createCodeifyModelWorkerDefinition(process.cwd(), runtime);
		const request = tool.execute("failure", { action: "run", model: "worker", task: "Work" }, undefined, undefined, {
			cwd: process.cwd(),
		});
		await expect(request).rejects.toThrow("Connection refused");
		await expect(request).rejects.not.toThrow("secret-password");
		await expect(request).rejects.not.toThrow("secret-token");
	});

	it("cancels a spawned agent through the background task manager", async () => {
		const selected = model("worker");
		const finished = vi.fn();
		const backgroundTasks = new BackgroundTaskManager(finished);
		const { runtime } = runtimeWith([selected], [{ text: "done", delayMs: 100 }]);
		const dispose = vi.fn();
		const tool = createCodeifyModelToolDefinition(process.cwd(), runtime, {
			backgroundTasks,
			createDelegatedTools: () => ({ tools: [], dispose }),
		});
		await tool.execute("spawn", { action: "run", model: "worker", task: "Work" }, undefined, undefined, {
			cwd: process.cwd(),
		});
		expect(backgroundTasks.stop("bg1")).toBe(true);
		await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
		expect(backgroundTasks.get("bg1")?.status).toBe("stopped");
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("accepts explicit budgets above the former caps and lists every model by default", async () => {
		const models = Array.from({ length: 110 }, (_, index) => model(`worker-${index}`));
		const { runtime } = runtimeWith(models, ["done"], (_selected, _context, options) => {
			expect(options?.maxTokens).toBe(30_000);
		});
		const tool = createCodeifyModelWorkerDefinition(process.cwd(), runtime);
		for (const field of ["maxOutputTokens", "maxTurns", "maxToolCalls", "limit"]) {
			expect(tool.parameters).not.toHaveProperty(`properties.${field}.maximum`);
		}
		const context = { cwd: process.cwd(), model: models[0] };
		const listed = await tool.execute("list", { action: "list" }, undefined, undefined, context);
		expect(listed.details).toMatchObject({ action: "list", count: 110 });
		const result = await tool.execute(
			"run",
			{
				action: "run",
				model: models[0].id,
				task: "Work",
				maxOutputTokens: 30_000,
				maxTurns: 100,
				maxToolCalls: 1000,
			},
			undefined,
			undefined,
			context,
		);
		expect(result.details).toMatchObject({ action: "run", status: "completed" });
	});

	it("lists all models by price with capability and delegated tool details", async () => {
		const main = model("main", { inputCost: 5, outputCost: 30 });
		const cheapVision = model("cheap-vision", { inputCost: 0.05, outputCost: 0.4 });
		const textOnly = model("text-only", { vision: false, inputCost: 0, outputCost: 0 });
		const { runtime } = runtimeWith([main, cheapVision, textOnly]);
		const tool = createCodeifyModelWorkerDefinition(process.cwd(), runtime, {
			getDelegatedToolNames: () => ["read", "write"],
		});

		const result = await tool.execute("list", { action: "list", capability: "vision" }, undefined, undefined, {
			cwd: process.cwd(),
			model: main,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("cheap-vision");
		expect(text).toContain("input:0.05 output:0.4");
		expect(text).toContain("read, write");
		expect(text).not.toContain("text-only");
		expect(text).toMatch(/^- main /mu);
		expect(result.details).toEqual({ action: "list", count: 2, toolNames: ["read", "write"] });
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
				expect(context.systemPrompt).toContain("fully agentic delegated coding agent working inside Codeify CLI");
				expect(context.systemPrompt).toContain("Only inspect notes.txt");
			},
		);
		const tool = createCodeifyModelWorkerDefinition(process.cwd(), runtime, {
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
		const tool = createCodeifyModelWorkerDefinition(process.cwd(), runtime, {
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
		const tool = createCodeifyModelWorkerDefinition(process.cwd(), runtime, {
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
		const tool = createCodeifyModelWorkerDefinition(process.cwd(), runtime, {
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

	it("reports an exhausted output budget instead of a missing summary", async () => {
		const main = model("main");
		const cheap = model("cheap");
		const { runtime } = runtimeWith([main, cheap], [{ text: "", stopReason: "length" }]);
		const tool = createCodeifyModelWorkerDefinition(process.cwd(), runtime, {
			createDelegatedTools: () => ({ tools: [] }),
		});

		const result = await tool.execute(
			"length-stop",
			{ action: "run", model: "cheap", task: "Summarize", allowedTools: [], maxOutputTokens: 64 },
			undefined,
			undefined,
			{ cwd: process.cwd(), model: main },
		);

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("64-token output limit");
		expect(text).toContain("maxOutputTokens");
		expect(text).not.toContain("without a text summary");
	});

	it("loads more than four image paths for vision delegation", async () => {
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
			expect(message.content.filter((item) => item.type === "image")).toHaveLength(6);
		});
		const tool = createCodeifyModelWorkerDefinition(directory, runtime);

		await tool.execute(
			"vision",
			{ action: "run", model: "vision", task: "Describe it", imagePaths: Array(6).fill("pixel.png") },
			undefined,
			undefined,
			{ cwd: directory, model: main },
		);
	});

	it("allows delegation to the main model", async () => {
		const main = model("main");
		const { runtime, contexts } = runtimeWith([main], ["self delegated answer"]);
		const tool = createCodeifyModelWorkerDefinition(process.cwd(), runtime);

		const result = await tool.execute(
			"run-main",
			{ action: "run", model: "main", task: "Do work" },
			undefined,
			undefined,
			{ cwd: process.cwd(), model: main },
		);

		expect(contexts).toHaveLength(1);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Delegated agent: main"),
		});
	});

	it("redacts provider failures that could contain a credential", async () => {
		const main = model("main");
		const cheap = model("cheap");
		const { runtime } = runtimeWith([main, cheap], [{ error: "Authorization: Bearer secret-codeify-key" }]);
		const tool = createCodeifyModelWorkerDefinition(process.cwd(), runtime);

		const request = tool.execute(
			"failure",
			{ action: "run", model: "cheap", task: "Do work" },
			undefined,
			undefined,
			{ cwd: process.cwd(), model: main },
		);
		await expect(request).rejects.toThrow("Delegated Codeify CLI agent request failed.");
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
		const tool = createCodeifyModelWorkerDefinition(process.cwd(), runtime);

		const request = tool.execute("list-failure", { action: "list" }, undefined, undefined, {
			cwd: process.cwd(),
			model: main,
		});
		await expect(request).rejects.toThrow("Unable to load delegated Codeify CLI models.");
		await expect(request).rejects.not.toThrow("secret-discovery-key");
	});

	it("allows more than five concurrent delegated agents", async () => {
		const main = model("main");
		const cheap = model("cheap");
		const { runtime } = runtimeWith([main, cheap], [{ text: "done", delayMs: 100 }]);
		const tool = createCodeifyModelWorkerDefinition(process.cwd(), runtime);
		const context = { cwd: process.cwd(), model: main };
		const requests = Array.from({ length: 8 }, (_, index) =>
			tool.execute(
				`request-${index}`,
				{ action: "run", model: "cheap", task: `Task ${index}` },
				undefined,
				undefined,
				context,
			),
		);

		const results = await Promise.all(requests);
		expect(results).toHaveLength(8);
		expect(results.every((result) => result.details?.action === "run" && result.details.status === "completed")).toBe(
			true,
		);
	});

	it("runs beyond former turn and tool-call caps with model output limits and full results", async () => {
		const selected = model("worker");
		const summary = "result ".repeat(10_000);
		const responses: FauxResponseInput[] = Array.from({ length: 14 }, () => ({
			toolCalls: Array.from({ length: 5 }, (_, index) => ({ name: "read", args: { path: `${index}.txt` } })),
		}));
		responses.push(summary);
		const executeRead = vi.fn(async () => "ok");
		const { runtime, contexts } = runtimeWith([selected], responses, (_model, _context, options) => {
			expect(options?.maxTokens).toBe(selected.maxTokens);
			expect(options?.timeoutMs).toBeUndefined();
		});
		const tool = createCodeifyModelWorkerDefinition(process.cwd(), runtime, {
			createDelegatedTools: () => ({ tools: [readTool(executeRead)] }),
		});
		const result = await tool.execute(
			"uncapped",
			{ action: "run", model: "worker", task: "x".repeat(33_000), restrictions: "y".repeat(9_000) },
			undefined,
			undefined,
			{ cwd: process.cwd(), model: selected },
		);
		expect(contexts).toHaveLength(15);
		expect(executeRead).toHaveBeenCalledTimes(70);
		expect(contexts[14]?.tools).toHaveLength(1);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(summary.trim()) });
	});

	it("keeps running beyond five minutes and disposes tools after completion", async () => {
		vi.useFakeTimers();
		const selected = model("worker");
		let finishRead: (value: string) => void = () => {};
		let startedRead: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			startedRead = resolve;
		});
		const pending = new Promise<string>((resolve) => {
			finishRead = resolve;
		});
		const dispose = vi.fn();
		const { runtime } = runtimeWith(
			[selected],
			[{ toolCalls: [{ name: "read", args: { path: "notes.txt" } }] }, "done"],
		);
		const tool = createCodeifyModelWorkerDefinition(process.cwd(), runtime, {
			createDelegatedTools: () => ({
				tools: [
					readTool(async () => {
						startedRead();
						return pending;
					}),
				],
				dispose,
			}),
		});
		const controller = new AbortController();
		const request = tool.execute(
			"long",
			{ action: "run", model: "worker", task: "Read" },
			controller.signal,
			undefined,
			{
				cwd: process.cwd(),
				model: selected,
			},
		);
		await started;
		await vi.advanceTimersByTimeAsync(300_001);
		finishRead("ok");
		await expect(request).resolves.toMatchObject({ details: { status: "completed", turns: 2 } });
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("cancels before starting a delegated agent", async () => {
		const main = model("main");
		const cheap = model("cheap");
		const { runtime } = runtimeWith([main, cheap]);
		const tool = createCodeifyModelWorkerDefinition(process.cwd(), runtime);
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
		const tool = createCodeifyModelWorkerDefinition(process.cwd(), runtime);
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

		expect(call).toContain("Delegate");
		expect(call).toContain("cheap");
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
			expect(harness.session.systemPrompt).toContain("fully agentic Codeify CLI model");
			expect(harness.session.systemPrompt).toContain("recommended for menial");
			harness.session.setSmartModelUsageEnabled(false);
			expect(harness.session.getActiveToolNames()).not.toContain("codeify_model");
			expect(harness.session.getAllTools().map((entry) => entry.name)).not.toContain("codeify_model");
		} finally {
			harness.cleanup();
		}
	});
});
