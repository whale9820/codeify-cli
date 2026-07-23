import { readFile, stat } from "node:fs/promises";
import { type AgentMessage, type AgentTool, runAgentLoop } from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Message,
	Model,
	ModelsSimpleStreamOptions,
	Usage,
} from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { resolvePath } from "../../utils/paths.ts";
import { CODEIFY_PROVIDER_ID } from "../codeify-provider.ts";
import type { ComputerPolicy } from "./computer.ts";
import { getTextOutput } from "./render-utils.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "./types.ts";

const MAX_PROMPT_CHARS = 32_000;
const MAX_RESTRICTION_CHARS = 8_000;
const MAX_IMAGE_COUNT = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
const MAX_OUTPUT_TOKENS = 16_384;
const DEFAULT_MAX_TURNS = 8;
const MAX_TURNS = 12;
const DEFAULT_MAX_TOOL_CALLS = 24;
const MAX_TOOL_CALLS = 64;
const MAX_CONCURRENT_CALLS = 5;
const MAX_RESULT_CHARS = 80_000;
const MAX_WALL_TIME_MS = 5 * 60_000;
const DEFAULT_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

class DelegationInputError extends Error {}

const effortSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);

const computerAccessSchema = Type.Object({
	allowedDomains: Type.Array(Type.String(), {
		description: "Exact domains the isolated browser may reach. Subdomains are included.",
		minItems: 1,
		maxItems: 32,
	}),
	allowNetworkWrites: Type.Optional(
		Type.Boolean({
			description:
				"Allow POST, PUT, PATCH, and DELETE browser requests. Keep false unless the user authorized them.",
		}),
	),
});

const codeifyModelSchema = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("run")], {
		description: "List eligible Codeify CLI models or run a bounded fully agentic task on one model",
	}),
	model: Type.Optional(Type.String({ description: "Codeify CLI model ID returned by the list action" })),
	task: Type.Optional(Type.String({ description: "Standalone task and only the context the delegated agent needs" })),
	allowedTools: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Exact tools the delegated agent may use. Defaults to available read-only tools. Mutation, shell, and computer tools must be explicitly granted. Use '*' to grant every available delegated tool.",
			maxItems: 32,
		}),
	),
	restrictions: Type.Optional(
		Type.String({
			description: "Mandatory scope and behavior restrictions for the delegated agent",
			maxLength: MAX_RESTRICTION_CHARS,
		}),
	),
	computerAccess: Type.Optional(computerAccessSchema),
	imagePaths: Type.Optional(
		Type.Array(Type.String(), {
			description: "Image files to attach for a vision task",
			maxItems: MAX_IMAGE_COUNT,
		}),
	),
	reasoningEffort: Type.Optional(effortSchema),
	maxOutputTokens: Type.Optional(
		Type.Integer({
			description: `Maximum response tokens per delegated turn, up to ${MAX_OUTPUT_TOKENS}`,
			minimum: 1,
			maximum: MAX_OUTPUT_TOKENS,
		}),
	),
	maxTurns: Type.Optional(
		Type.Integer({
			description: `Maximum delegated model turns, from 2 to ${MAX_TURNS}`,
			minimum: 2,
			maximum: MAX_TURNS,
		}),
	),
	maxToolCalls: Type.Optional(
		Type.Integer({
			description: `Maximum delegated tool attempts, up to ${MAX_TOOL_CALLS}`,
			minimum: 1,
			maximum: MAX_TOOL_CALLS,
		}),
	),
	capability: Type.Optional(
		Type.Union([Type.Literal("any"), Type.Literal("vision"), Type.Literal("reasoning")], {
			description: "Filter the list action by capability",
		}),
	),
	limit: Type.Optional(Type.Integer({ description: "Maximum models returned by list", minimum: 1, maximum: 100 })),
});

export type CodeifyModelToolInput = Static<typeof codeifyModelSchema>;

export interface DelegatedToolSet {
	tools: AgentTool[];
	dispose?: () => Promise<void> | void;
}

export type CodeifyModelToolDetails =
	| { action: "list"; count: number; toolNames: string[] }
	| {
			action: "run";
			model: string;
			status: "running" | "completed";
			turns: number;
			toolCalls: number;
			completedToolCalls: number;
			allowedTools: string[];
			currentTool?: string;
			filesChanged: string[];
			stopReason?: AssistantMessage["stopReason"];
			usage?: Usage;
	  };

export interface CodeifyModelToolRuntime {
	getAvailable(providerId?: string): Promise<readonly Model<Api>[]>;
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
}

export interface CodeifyModelToolOptions {
	imagesBlocked?: () => boolean;
	autoResizeImages?: () => boolean;
	getDelegatedToolNames?: () => readonly string[];
	createDelegatedTools?: (computerPolicy?: ComputerPolicy) => DelegatedToolSet;
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsage(total: Usage, usage: Usage): void {
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.totalTokens += usage.totalTokens;
	if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
	total.cost.input += usage.cost.input;
	total.cost.output += usage.cost.output;
	total.cost.cacheRead += usage.cost.cacheRead;
	total.cost.cacheWrite += usage.cost.cacheWrite;
	total.cost.total += usage.cost.total;
}

function modelPrice(model: Model<Api>): number {
	return model.cost.input + model.cost.output;
}

function formatRate(rate: number): string {
	return Number.isInteger(rate) ? String(rate) : rate.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
}

function formatModel(model: Model<Api>): string {
	const capabilities = [model.input.includes("image") ? "vision" : "text-only"];
	const levels = getSupportedThinkingLevels(model);
	if (model.reasoning) capabilities.push(`reasoning:${levels.join(",")}`);
	return `- ${model.id} | ${model.name} | ${capabilities.join(" | ")} | context:${model.contextWindow} | max-output:${model.maxTokens} | $/M input:${formatRate(model.cost.input)} output:${formatRate(model.cost.output)} cache-read:${formatRate(model.cost.cacheRead)} cache-write:${formatRate(model.cost.cacheWrite)}`;
}

function responseText(messages: readonly AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((item): item is Extract<(typeof message.content)[number], { type: "text" }> => item.type === "text")
			.map((item) => item.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

function usageLine(usage: Usage): string {
	return `Usage: ${usage.input} input, ${usage.output} output, ${usage.cacheRead} cache read, $${usage.cost.total.toFixed(6)}`;
}

async function getCodeifyModels(runtime: CodeifyModelToolRuntime): Promise<readonly Model<Api>[]> {
	try {
		return await runtime.getAvailable(CODEIFY_PROVIDER_ID);
	} catch {
		throw new DelegationInputError("Unable to load delegated Codeify CLI models.");
	}
}

async function loadImages(paths: readonly string[], cwd: string, autoResizeImages: boolean): Promise<ImageContent[]> {
	if (paths.length > MAX_IMAGE_COUNT)
		throw new DelegationInputError(`A delegated request supports at most ${MAX_IMAGE_COUNT} images.`);
	let totalBytes = 0;
	const images: ImageContent[] = [];
	for (const path of paths) {
		const absolutePath = resolvePath(path, cwd);
		const fileStats = await stat(absolutePath);
		if (!fileStats.isFile()) throw new DelegationInputError(`Delegated image is not a file: ${path}`);
		if (fileStats.size > MAX_IMAGE_BYTES)
			throw new DelegationInputError(`Delegated image exceeds the 10 MB limit: ${path}`);
		totalBytes += fileStats.size;
		if (totalBytes > MAX_TOTAL_IMAGE_BYTES)
			throw new DelegationInputError("Delegated images exceed the 20 MB combined limit.");
		const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);
		if (!mimeType) throw new DelegationInputError(`Unsupported delegated image: ${path}`);
		const processed = await processImage(await readFile(absolutePath), mimeType, { autoResizeImages });
		if (!processed.ok) throw new DelegationInputError(`Could not prepare delegated image: ${path}`);
		images.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
	}
	return images;
}

function delegatedToolNames(options: CodeifyModelToolOptions): string[] {
	return [...new Set([...(options.getDelegatedToolNames?.() ?? []), "computer"])]
		.filter((name) => name !== "codeify_model")
		.sort();
}

function selectDelegatedTools(
	params: CodeifyModelToolInput,
	options: CodeifyModelToolOptions,
): { toolSet: DelegatedToolSet; tools: AgentTool[]; names: string[] } {
	const computerPolicy = params.computerAccess
		? {
				allowedDomains: params.computerAccess.allowedDomains,
				allowNetworkWrites: params.computerAccess.allowNetworkWrites,
			}
		: undefined;
	const toolSet = options.createDelegatedTools?.(computerPolicy) ?? { tools: [] };
	const available = new Map(
		toolSet.tools.filter((tool) => tool.name !== "codeify_model").map((tool) => [tool.name, tool]),
	);
	const requested = params.allowedTools ?? DEFAULT_READ_ONLY_TOOLS.filter((name) => available.has(name));
	const names = requested.includes("*") ? [...available.keys()] : [...new Set(requested)];
	const unknown = names.filter((name) => !available.has(name));
	if (unknown.length > 0) throw new DelegationInputError(`Delegated tools are unavailable: ${unknown.join(", ")}`);
	if (names.includes("computer") && !computerPolicy) {
		throw new DelegationInputError("Delegated computer use requires computerAccess.allowedDomains.");
	}
	return { toolSet, tools: names.map((name) => available.get(name)!), names };
}

function delegatedSystemPrompt(cwd: string, restrictions: string | undefined, toolNames: readonly string[]): string {
	const scope = restrictions?.trim() || "Complete only the assigned task and do not expand its scope.";
	return [
		"You are a fully agentic delegated Codeify CLI coding agent.",
		`Your working directory is ${cwd}.`,
		`You may use only these tools: ${toolNames.length > 0 ? toolNames.join(", ") : "none"}.`,
		"The main agent selected your model, tools, and restrictions. They are mandatory.",
		"Do not attempt to delegate to another model, discover credentials, or access Codeify CLI authentication.",
		"Use tools autonomously until the task is complete, then return a concise result with material findings and changed files.",
		`Restrictions: ${scope}`,
	].join("\n");
}

function formatCodeifyModelCall(args: CodeifyModelToolInput | undefined, theme: Theme): string {
	if (args?.action === "list") {
		const capability = args.capability && args.capability !== "any" ? ` · ${args.capability}` : "";
		const limit = args.limit ? ` · limit ${args.limit}` : "";
		return `${theme.fg("toolTitle", theme.bold("smart models"))}${theme.fg("muted", `${capability}${limit}`)}`;
	}
	const model = args?.model || "...";
	const tools = args?.allowedTools?.length ? args.allowedTools.join(", ") : "read-only";
	const turns = args?.maxTurns ?? DEFAULT_MAX_TURNS;
	const task = args?.task?.replace(/\s+/gu, " ").trim();
	let text = `${theme.fg("toolTitle", theme.bold(`delegate ${model}`))}${theme.fg("muted", ` · ${tools} · up to ${turns} turns`)}`;
	if (task) text += `\n${theme.fg("toolOutput", task.length > 180 ? `${task.slice(0, 180)}...` : task)}`;
	return text;
}

function formatCodeifyModelResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: CodeifyModelToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const details = result.details;
	if (!details) return "";
	if (details.action === "list") {
		return `\n${theme.fg("muted", `${details.count} eligible models · tools: ${details.toolNames.join(", ") || "none"}`)}`;
	}
	const status =
		details.status === "running"
			? "running"
			: details.stopReason === "stop"
				? "completed"
				: details.stopReason || "completed";
	const parts = [
		status,
		`${details.turns} turn${details.turns === 1 ? "" : "s"}`,
		`${details.completedToolCalls}/${details.toolCalls} tools`,
	];
	if (details.currentTool) parts.push(`using ${details.currentTool}`);
	if (details.filesChanged.length > 0) parts.push(`${details.filesChanged.length} files changed`);
	if (details.usage) parts.push(`$${details.usage.cost.total.toFixed(6)}`);
	let text = `\n${theme.fg("muted", parts.join(" · "))}`;
	if (details.status === "completed") {
		const output = getTextOutput(result, showImages).trim();
		if (output) {
			const lines = output.split("\n");
			const shown = options.expanded ? lines : lines.slice(0, 14);
			text += `\n${shown.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
			if (shown.length < lines.length)
				text += `\n${theme.fg("muted", `... (${lines.length - shown.length} more lines)`)}`;
		}
	}
	return text;
}

export function createCodeifyModelToolDefinition(
	cwd: string,
	runtime: CodeifyModelToolRuntime,
	options: CodeifyModelToolOptions = {},
): ToolDefinition<typeof codeifyModelSchema, CodeifyModelToolDetails> {
	let activeCalls = 0;
	return {
		name: "codeify_model",
		label: "Codeify CLI agent",
		description:
			"Securely list and delegate work to other models offered by Codeify CLI. Delegated models run as bounded fully agentic coding agents with only the tools, domains, scope, and restrictions you grant. Authentication stays inside the Codeify CLI harness and is never visible to either agent.",
		promptSnippet: "Delegate bounded work to a cheaper or specialized fully agentic Codeify CLI model",
		promptGuidelines: [
			"Delegation is available and recommended for menial, repetitive, low-judgment, search, formatting, test-triage, and inexpensive vision work so you preserve valuable reasoning and context for difficult decisions.",
			"Delegated models are fully agentic: choose the model, exact tools, restrictions, turn limit, and task scope, then review their result before making final decisions.",
			"Prefer the cheapest suitable model, list models when price or capability is unknown, and pass only the minimum context required.",
			"Read-only tools are the default. Explicitly grant bash, edit, write, custom mutation tools, or computer only when required. Computer use also requires a narrow domain allowlist.",
			"Keep architecture, security-sensitive judgment, final review, and user-facing decisions in the main model.",
		],
		parameters: codeifyModelSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (params.action === "list") {
				let models = [...(await getCodeifyModels(runtime))].filter(
					(model) => !(ctx.model?.provider === CODEIFY_PROVIDER_ID && ctx.model.id === model.id),
				);
				if (params.capability === "vision") models = models.filter((model) => model.input.includes("image"));
				if (params.capability === "reasoning") models = models.filter((model) => model.reasoning);
				models.sort((left, right) => modelPrice(left) - modelPrice(right) || left.id.localeCompare(right.id));
				models = models.slice(0, params.limit ?? 50);
				const current =
					ctx.model?.provider === CODEIFY_PROVIDER_ID
						? ` The main model ${ctx.model.id} is intentionally excluded.`
						: "";
				const toolNames = delegatedToolNames(options);
				const text =
					models.length > 0
						? `Eligible delegated Codeify CLI models, sorted by combined input/output price. Prices are USD per million tokens.${current}\nDelegated agents can use: ${toolNames.join(", ") || "no tools"}. Computer requires computerAccess.allowedDomains.\n${models.map(formatModel).join("\n")}`
						: `No other Codeify CLI models match this request.${current}`;
				return { content: [{ type: "text", text }], details: { action: "list", count: models.length, toolNames } };
			}

			const task = params.task?.trim();
			if (!params.model?.trim()) throw new Error("The run action requires a model ID from the list action.");
			if (!task) throw new Error("The run action requires a standalone task.");
			if (task.length > MAX_PROMPT_CHARS) {
				throw new Error(`Delegated tasks are limited to ${MAX_PROMPT_CHARS} characters.`);
			}
			if (signal?.aborted) throw new Error("Delegated Codeify CLI agent request was cancelled.");
			if (activeCalls >= MAX_CONCURRENT_CALLS) {
				throw new Error(`At most ${MAX_CONCURRENT_CALLS} delegated Codeify CLI agents can run concurrently.`);
			}
			activeCalls++;
			let toolSet: DelegatedToolSet | undefined;
			try {
				const modelId = params.model.replace(/^codeify\//u, "");
				const models = await getCodeifyModels(runtime);
				const model = models.find((candidate) => candidate.id === modelId);
				if (!model) throw new DelegationInputError(`Codeify CLI model is not available: ${modelId}`);
				if (ctx.model?.provider === CODEIFY_PROVIDER_ID && ctx.model.id === model.id) {
					throw new DelegationInputError("Choose a model other than the main model for delegation.");
				}

				const imagePaths = params.imagePaths ?? [];
				if (imagePaths.length > 0 && options.imagesBlocked?.()) {
					throw new DelegationInputError("Image sending is disabled in Codeify CLI settings.");
				}
				if (imagePaths.length > 0 && !model.input.includes("image")) {
					throw new DelegationInputError(`Codeify CLI model does not support images: ${model.id}`);
				}
				const supportedEfforts = getSupportedThinkingLevels(model);
				if (params.reasoningEffort && !supportedEfforts.includes(params.reasoningEffort)) {
					throw new DelegationInputError(
						`Unsupported reasoning effort for ${model.id}: ${params.reasoningEffort}`,
					);
				}

				const selected = selectDelegatedTools(params, options);
				toolSet = selected.toolSet;
				const images = await loadImages(imagePaths, cwd, options.autoResizeImages?.() ?? true);
				const content = [{ type: "text" as const, text: task }, ...images];
				const maxTokens = Math.min(
					params.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
					model.maxTokens,
					MAX_OUTPUT_TOKENS,
				);
				const maxTurns = params.maxTurns ?? DEFAULT_MAX_TURNS;
				const maxToolCalls = params.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
				const usage = emptyUsage();
				const filesChanged = new Set<string>();
				const toolArgs = new Map<string, unknown>();
				let turns = 0;
				let toolCalls = 0;
				let completedToolCalls = 0;
				let currentTool: string | undefined;
				let lastStopReason: AssistantMessage["stopReason"] | undefined;
				const progressDetails = (
					status: "running" | "completed",
				): Extract<CodeifyModelToolDetails, { action: "run" }> => ({
					action: "run",
					model: model.id,
					status,
					turns,
					toolCalls,
					completedToolCalls,
					allowedTools: selected.names,
					currentTool,
					filesChanged: [...filesChanged],
					stopReason: status === "completed" ? lastStopReason : undefined,
					usage: status === "completed" ? usage : undefined,
				});
				const emitProgress = () => {
					onUpdate?.({
						content: [{ type: "text", text: `Delegated agent ${model.id} is running.` }],
						details: progressDetails("running"),
					});
				};
				const abortController = new AbortController();
				let timedOut = false;
				const forwardAbort = () => abortController.abort();
				if (signal?.aborted) forwardAbort();
				else signal?.addEventListener("abort", forwardAbort, { once: true });
				const timeout = setTimeout(() => {
					timedOut = true;
					abortController.abort();
				}, MAX_WALL_TIME_MS);
				let messages: AgentMessage[];
				try {
					messages = await runAgentLoop(
						[{ role: "user", content, timestamp: Date.now() }],
						{
							systemPrompt: delegatedSystemPrompt(cwd, params.restrictions, selected.names),
							messages: [],
							tools: selected.tools,
						},
						{
							model,
							maxTokens,
							reasoning: params.reasoningEffort === "off" ? undefined : params.reasoningEffort,
							timeoutMs: 120_000,
							maxRetries: 1,
							toolExecution: "parallel",
							convertToLlm: (agentMessages) =>
								agentMessages.filter(
									(message): message is Message =>
										message.role === "user" || message.role === "assistant" || message.role === "toolResult",
								),
							beforeToolCall: async () =>
								toolCalls > maxToolCalls
									? { block: true, reason: `Delegated tool-call limit reached (${maxToolCalls}).` }
									: undefined,
							prepareNextTurn: ({ context: nextContext, toolResults }) =>
								turns >= maxTurns - 1 && toolResults.length > 0
									? {
											context: {
												...nextContext,
												tools: [],
												systemPrompt: `${nextContext.systemPrompt}\nThis is your final turn. Do not call tools. Return the best concise result now.`,
											},
										}
									: undefined,
							shouldStopAfterTurn: () => turns >= maxTurns,
						},
						(event) => {
							if (event.type === "message_end" && event.message.role === "assistant") {
								addUsage(usage, event.message.usage);
								lastStopReason = event.message.stopReason;
							}
							if (event.type === "turn_end") {
								turns++;
								emitProgress();
							}
							if (event.type === "tool_execution_start") {
								toolCalls++;
								currentTool = event.toolName;
								toolArgs.set(event.toolCallId, event.args);
								emitProgress();
							}
							if (event.type === "tool_execution_end") {
								completedToolCalls++;
								currentTool = undefined;
								if (event.result.usage) addUsage(usage, event.result.usage);
								if (!event.isError && (event.toolName === "edit" || event.toolName === "write")) {
									const args = toolArgs.get(event.toolCallId);
									if (args && typeof args === "object" && "path" in args && typeof args.path === "string") {
										filesChanged.add(args.path);
									}
								}
								emitProgress();
							}
						},
						abortController.signal,
						(streamModel, streamContext, streamOptions) =>
							runtime.streamSimple(streamModel, streamContext, streamOptions),
					);
				} finally {
					clearTimeout(timeout);
					signal?.removeEventListener("abort", forwardAbort);
				}
				if (timedOut) throw new Error("Delegated Codeify CLI agent exceeded the five-minute limit.");
				if (signal?.aborted || lastStopReason === "aborted") {
					throw new Error("Delegated Codeify CLI agent request was cancelled.");
				}
				if (lastStopReason === "error") throw new Error("Delegated Codeify CLI agent request failed.");
				const rawText = responseText(messages);
				const fallback =
					turns >= maxTurns
						? `Delegated agent reached its ${maxTurns}-turn limit after ${completedToolCalls} completed tool calls.`
						: "Delegated agent completed without a text summary.";
				const answer = rawText || fallback;
				const text =
					answer.length > MAX_RESULT_CHARS
						? `${answer.slice(0, MAX_RESULT_CHARS)}\n\n[Delegated response truncated by Codeify CLI.]`
						: answer;
				const fileLine = filesChanged.size > 0 ? `\nFiles changed: ${[...filesChanged].join(", ")}` : "";
				return {
					content: [
						{
							type: "text",
							text: `Delegated agent: ${model.id}\nTools: ${selected.names.join(", ") || "none"}\nTurns: ${turns}; tool calls: ${completedToolCalls}/${toolCalls}${fileLine}\n${usageLine(usage)}\n\n${text}`,
						},
					],
					details: progressDetails("completed"),
					usage,
				};
			} catch (error) {
				if (error instanceof DelegationInputError) throw error;
				if (
					error instanceof Error &&
					[
						"Delegated Codeify CLI agent request was cancelled.",
						"Delegated Codeify CLI agent request failed.",
						"Delegated Codeify CLI agent exceeded the five-minute limit.",
					].includes(error.message)
				) {
					throw error;
				}
				throw new Error(
					signal?.aborted
						? "Delegated Codeify CLI agent request was cancelled."
						: "Delegated Codeify CLI agent request failed.",
				);
			} finally {
				await toolSet?.dispose?.();
				activeCalls--;
			}
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatCodeifyModelCall(args, theme));
			return text;
		},
		renderResult(result, renderOptions, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatCodeifyModelResult(result, renderOptions, theme, context.showImages));
			return text;
		},
	};
}
