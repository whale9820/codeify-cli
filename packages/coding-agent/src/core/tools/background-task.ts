import type { AgentToolResult } from "codeify-agent-core";
import { Text } from "codeify-tui";
import { type Static, Type } from "typebox";
import { type BackgroundTask, formatTaskLine } from "../background-tasks.ts";
import { defineTool, type ToolDefinition } from "./types.ts";

const backgroundTaskSchema = Type.Object({
	action: Type.Union([Type.Literal("start"), Type.Literal("list"), Type.Literal("output"), Type.Literal("stop")], {
		description: "start a background task, list tasks, read a task's captured output, or stop a running task",
	}),
	command: Type.Optional(
		Type.String({ description: "Shell command to run in the background (start with a command task)" }),
	),
	model: Type.Optional(
		Type.String({
			description: "Codeify CLI model ID to run a delegated agent task in the background (use with task)",
		}),
	),
	task: Type.Optional(Type.String({ description: "Standalone task for a delegated background agent" })),
	allowedTools: Type.Optional(
		Type.Array(Type.String(), { description: "Tools the delegated background agent may use", maxItems: 32 }),
	),
	description: Type.Optional(Type.String({ description: "Short label shown to the user for a started task" })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds for a command task" })),
	id: Type.Optional(Type.String({ description: "Task ID for output and stop" })),
	sinceLast: Type.Optional(
		Type.Boolean({
			description:
				"output only: return just the output produced since the last output read of this task, instead of everything captured",
		}),
	),
	filter: Type.Optional(
		Type.String({
			description: "output only: regular expression; only matching lines are returned (like grep)",
		}),
	),
});

export type BackgroundTaskToolInput = Static<typeof backgroundTaskSchema>;

export interface BackgroundTaskToolDetails {
	action: BackgroundTaskToolInput["action"];
	task?: BackgroundTask;
	tasks?: BackgroundTask[];
}

export interface BackgroundTaskOperations {
	startCommand: (command: string, description: string, timeout: number | undefined) => BackgroundTask;
	startAgent?: (
		model: string,
		task: string,
		allowedTools: string[] | undefined,
		description: string,
	) => BackgroundTask;
	list: () => BackgroundTask[];
	get: (id: string) => BackgroundTask | undefined;
	readOutput: (id: string) => { text: string; droppedChars: number } | undefined;
	readNewOutput: (id: string) => { text: string; droppedChars: number } | undefined;
	stop: (id: string) => boolean;
}

function text(value: string, details: BackgroundTaskToolDetails): AgentToolResult<BackgroundTaskToolDetails> {
	return { content: [{ type: "text", text: value }], details };
}

export function createBackgroundTaskToolDefinition(
	ops: BackgroundTaskOperations,
): ToolDefinition<typeof backgroundTaskSchema, BackgroundTaskToolDetails> {
	return defineTool({
		name: "background_task",
		label: "Background task",
		description: [
			"Run work in the background so the conversation stays free while it runs.",
			"",
			'Actions: "start" launches a shell command (command) or a delegated agent (model and task) and returns immediately with a task ID; "list" shows all tasks; "output" reads the captured output of a task (sinceLast: true returns only new output since the last read, filter: a regex to keep matching lines); "stop" cancels a running task.',
			"When a background task finishes, its result is delivered automatically before your next response, after the current response and tool calls finish. Do not poll or sleep waiting for it.",
		].join("\n"),
		promptSnippet:
			"Prefer this for anything that may take more than a few seconds: run commands or delegated agent work in the background; results are reported back automatically when done.",
		promptGuidelines: [
			"Default to background_task instead of bash for anything that could take more than a few seconds: installs, builds, test suites, linters, type checks, dev servers, watchers, large searches, and delegated agent work. There is no downside: the result is delivered back to you automatically, and the user can keep chatting and giving you other work in the meantime.",
			"Use plain bash only for quick commands whose output you need immediately to decide your very next step.",
			"Start independent background tasks together. Continue only with useful work that does not depend on their results. If a background task is the main task or its result is needed for your next step, briefly say what you are waiting for and end your response without tool calls. The session will wait and resume you automatically when the result arrives; the user can still send messages.",
			"After starting a background task, briefly tell the user it is running. Completion results arrive during your work; incorporate them into your next steps and final answer. Avoid repeating acknowledgments for results you already reviewed.",
			"Do not busy-wait on a background task with sleep or repeated list calls.",
			"Do not invent extra work, rerun the same task, make speculative changes, or claim completion while a required background result is pending.",
			"Your turn stays open until every running background task has finished and you have reacted to its result. Stop long-lived tasks (dev servers, watchers) with the stop action once you no longer need them, or the turn will never end.",
		],
		parameters: backgroundTaskSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params): Promise<AgentToolResult<BackgroundTaskToolDetails>> {
			switch (params.action) {
				case "start": {
					const command = params.command?.trim();
					const prompt = params.task?.trim();
					if (command && prompt) throw new Error("Provide either command or task, not both.");
					if (command) {
						const task = ops.startCommand(command, params.description?.trim() || command, params.timeout);
						return text(
							`Started background task ${task.id}. Its result will arrive automatically. Continue only with independent work; if you need this result or have no useful work left, end your response and wait for the automatic notification. Do not poll, sleep, or rerun the task.`,
							{ action: "start", task },
						);
					}
					if (prompt) {
						if (!ops.startAgent) throw new Error("Background agent tasks are unavailable in this session.");
						if (!params.model?.trim()) throw new Error("Agent tasks require a model ID.");
						const task = ops.startAgent(
							params.model.trim(),
							prompt,
							params.allowedTools,
							params.description?.trim() || prompt.replace(/\s+/gu, " ").slice(0, 80),
						);
						return text(
							`Started background agent task ${task.id}. Its result will arrive automatically. Continue only with independent work; if you need this result or have no useful work left, end your response and wait for the automatic notification. Do not poll, sleep, or rerun the task.`,
							{ action: "start", task },
						);
					}
					throw new Error("start requires a command or a task.");
				}
				case "list": {
					const tasks = ops.list();
					return text(tasks.length > 0 ? tasks.map(formatTaskLine).join("\n") : "No background tasks.", {
						action: "list",
						tasks,
					});
				}
				case "output": {
					if (!params.id) throw new Error("output requires an id.");
					const task = ops.get(params.id);
					const output = params.sinceLast ? ops.readNewOutput(params.id) : ops.readOutput(params.id);
					if (!task || !output) throw new Error(`Unknown background task: ${params.id}`);
					let body = output.text;
					if (params.filter) {
						let pattern: RegExp;
						try {
							pattern = new RegExp(params.filter);
						} catch {
							throw new Error(`Invalid filter regular expression: ${params.filter}`);
						}
						body = body
							.split("\n")
							.filter((line) => pattern.test(line))
							.join("\n");
					}
					const dropped =
						output.droppedChars > 0 ? `[${output.droppedChars} earlier characters were dropped]\n` : "";
					const empty = params.sinceLast ? "(no new output)" : "(no output yet)";
					return text(`${formatTaskLine(task)}\n${dropped}${body || empty}`, {
						action: "output",
						task,
					});
				}
				case "stop": {
					if (!params.id) throw new Error("stop requires an id.");
					const task = ops.get(params.id);
					if (!task) throw new Error(`Unknown background task: ${params.id}`);
					const stopped = ops.stop(params.id);
					return text(stopped ? `Stopping background task ${params.id}.` : `Task ${params.id} is not running.`, {
						action: "stop",
						task,
					});
				}
			}
		},
		renderCall(args, theme) {
			const detail =
				args?.action === "start"
					? ` · ${args.description || args.command || args.task?.replace(/\s+/gu, " ").slice(0, 80) || "..."}`
					: args?.id
						? ` · ${args.id}`
						: "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold(`background ${args?.action ?? ""}`))}${theme.fg("muted", detail)}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const block = result.content.find((item) => item.type === "text");
			return new Text(theme.fg("toolOutput", block?.type === "text" ? block.text : ""), 0, 0);
		},
	});
}
