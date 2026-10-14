import { resetCapabilitiesCache, setCapabilities, setKeybindings, type TUI } from "codeify-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { McpManager } from "../src/core/mcp/manager.ts";
import { createMcpToolDefinition } from "../src/core/mcp/tool.ts";
import { createBackgroundTaskToolDefinition } from "../src/core/tools/background-task.ts";
import { createBrowserToolDefinition } from "../src/core/tools/browser.ts";
import { BrowserBridge } from "../src/core/tools/browser-bridge.ts";
import { createCodeifyModelWorkerDefinition } from "../src/core/tools/codeify-model.ts";
import { createContextUsageToolDefinition } from "../src/core/tools/context-usage.ts";
import { createUpdateGoalToolDefinition } from "../src/core/tools/goal.ts";
import { createAllToolDefinitions } from "../src/core/tools/index.ts";
import { createRequestUserInputToolDefinition } from "../src/core/tools/request-user-input.ts";
import type { AnyToolDefinition } from "../src/core/tools/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ui = { requestRender() {} } as unknown as TUI;
const cwd = process.cwd();
const modelTool = createCodeifyModelWorkerDefinition(cwd, {
	getAvailable: async () => [],
	streamSimple: () => {
		throw new Error("Rendering must not call a provider");
	},
});
const background = createBackgroundTaskToolDefinition({
	startCommand: () => {
		throw new Error("Rendering must not start tasks");
	},
	list: () => [],
	get: () => undefined,
	readOutput: () => undefined,
	readNewOutput: () => undefined,
	stop: () => false,
});
const goal = createUpdateGoalToolDefinition({ getGoal: () => undefined, completeGoal() {}, blockGoal() {} });
const context = createContextUsageToolDefinition({ getSnapshot: () => undefined, requestCompaction() {} });
const browser = createBrowserToolDefinition(cwd, new BrowserBridge());
const mcp = createMcpToolDefinition(new McpManager({ mcpServers: {} }), []);
const ask = createRequestUserInputToolDefinition(async () => []);

const scenarios: Array<{
	definition: AnyToolDefinition;
	args: Record<string, unknown>;
	label: string;
	details?: unknown;
}> = [
	{
		definition: modelTool,
		args: { action: "list" },
		label: "SmartModels(all)",
		details: { action: "list", count: 139, toolNames: [] },
	},
	{
		definition: modelTool,
		args: { action: "list", capability: "vision", limit: 10 },
		label: "SmartModels(vision, limit: 10)",
		details: { action: "list", count: 139, toolNames: [] },
	},
	{
		definition: modelTool,
		args: { action: "run", model: "claude-haiku-5-5" },
		label: "Delegate(claude-haiku-5-5)",
		details: {
			action: "run",
			model: "claude-haiku-5-5",
			status: "completed",
			turns: 1,
			toolCalls: 0,
			completedToolCalls: 0,
			allowedTools: [],
			filesChanged: [],
		},
	},
	...(["start", "list", "output", "stop"] as const).map((action) => ({
		definition: background,
		args: { action, ...(action === "start" ? { command: "pwd" } : action === "list" ? {} : { id: "bg1" }) },
		label: `Background(${action}${action === "start" ? ", pwd" : action === "list" ? "" : ", bg1"})`,
	})),
	{ definition: goal, args: { status: "complete" }, label: "Goal(complete)" },
	{ definition: goal, args: { status: "blocked" }, label: "Goal(blocked)" },
	{ definition: context, args: {}, label: "Context(usage)" },
	{ definition: context, args: { request_compaction: true }, label: "Context(request compaction)" },
	{ definition: browser, args: { action: "snapshot" }, label: "Browser(snapshot)" },
	{ definition: mcp, args: { connect: "rea" }, label: "MCP(rea)" },
	{ definition: ask, args: { questions: [{ question: "Continue?" }] }, label: "AskUser(Continue?)" },
];

describe("built-in tool label and output inventory", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	for (const [name, definition] of Object.entries(createAllToolDefinitions(cwd))) {
		it(`uses Name(args) for ${name}`, () => {
			const component = new ToolExecutionComponent(
				name,
				name,
				{ path: "notes.txt", command: "pwd", content: "one", pattern: "*.ts", query: "codeify" },
				{},
				definition,
				ui,
				cwd,
			);
			const rendered = component
				.render(160)
				.map(stripAnsi)
				.find((line) => line.trim());
			expect(rendered?.trim()).toMatch(/^● [A-Z][A-Za-z]*\(/u);
		});
	}

	for (const scenario of scenarios) {
		it(`renders and expands ${scenario.label}`, () => {
			const { definition, args, details, label } = scenario;
			const component = new ToolExecutionComponent(definition.name, label, args, {}, definition, ui, cwd);
			expect(stripAnsi(component.render(160).join("\n"))).toContain(label);
			const output = Array.from({ length: 139 }, (_, index) => `entry-${index}`).join("\n");
			for (const isError of [false, true]) {
				component.updateResult({
					content: [{ type: "text", text: output }],
					details: isError
						? undefined
						: definition.name === "request_user_input"
							? { answers: [output] }
							: details,
					isError,
				});
				const collapsed = component.render(80).map(stripAnsi);
				expect(collapsed.length).toBeLessThanOrEqual(22);
				expect(collapsed.join("\n")).toContain("ctrl+o to expand");
				component.setExpanded(true);
				const expanded = stripAnsi(component.render(80).join("\n"));
				expect(expanded).toContain("entry-138");
				component.setExpanded(false);
			}
		});
	}

	it("keeps long delegated task text available on expansion", () => {
		const component = new ToolExecutionComponent(
			"codeify_model",
			"long-task",
			{ action: "run", model: "claude-haiku-5-5", task: `${"work ".repeat(500)}task-end` },
			{},
			modelTool,
			ui,
			cwd,
		);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("ctrl+o to expand");
		component.setExpanded(true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("task-end");
	});

	for (const definition of [undefined, background, createAllToolDefinitions(cwd).write]) {
		it(`collapses image output for ${definition?.name ?? "unknown tools"}`, () => {
			setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
			try {
				const component = new ToolExecutionComponent(
					definition?.name ?? "custom_tool",
					"images",
					{ action: "output", id: "bg1", path: "notes.txt", content: "one" },
					{},
					definition,
					ui,
					cwd,
				);
				component.updateResult({
					content: Array.from({ length: 30 }, () => ({
						type: "image",
						mimeType: "image/png",
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
					})),
					isError: false,
				});
				const collapsed = component.render(80);
				expect(collapsed.length).toBeLessThanOrEqual(22);
				expect(stripAnsi(collapsed.join("\n"))).toContain("ctrl+o to expand (30 images)");
				component.setExpanded(true);
				expect(component.render(80).length).toBeGreaterThan(30);
			} finally {
				resetCapabilitiesCache();
			}
		});
	}
});
