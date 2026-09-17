import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "codeify-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createAgentSession,
	createAllToolDefinitions,
	createAllTools,
	createGlobTool,
	createGlobToolDefinition,
	createTool,
	createToolDefinition,
} from "../src/index.ts";

describe("glob tool support", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `glob-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("creates glob tool definition and wraps it as a tool", async () => {
		const def = createGlobToolDefinition(cwd);
		expect(def.name).toBe("glob");
		expect(def.label).toBe("glob");
		expect(def.promptSnippet).toContain("Find files by glob pattern");

		const tool = createGlobTool(cwd);
		expect(tool.name).toBe("glob");
		expect(tool.description).toContain("Search for files by glob pattern");
	});

	it("resolves glob through createToolDefinition and createTool", async () => {
		const def = createToolDefinition("glob", cwd);
		expect(def.name).toBe("glob");

		const tool = createTool("glob", cwd);
		expect(tool.name).toBe("glob");
	});

	it("includes glob in createAllToolDefinitions and createAllTools", async () => {
		const allDefs = createAllToolDefinitions(cwd);
		expect(allDefs.glob).toBeDefined();
		expect(allDefs.glob.name).toBe("glob");
		expect(allDefs.find).toBeDefined();
		expect(allDefs.find.name).toBe("find");

		const allTools = createAllTools(cwd);
		expect(allTools.glob).toBeDefined();
		expect(allTools.glob.name).toBe("glob");
		expect(allTools.find).toBeDefined();
		expect(allTools.find.name).toBe("find");
	});

	it("executes file search via glob tool definition and tool", async () => {
		writeFileSync(join(cwd, "alpha.txt"), "hello");
		writeFileSync(join(cwd, "beta.ts"), "export const x = 1;");

		const tool = createGlobTool(cwd);
		const result = await tool.execute("call-1", { pattern: "*.ts" });
		const text = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n");

		expect(text).toContain("beta.ts");
		expect(text).not.toContain("alpha.txt");
	});

	it("activates glob when tools: ['glob'] is provided to createAgentSession", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			tools: ["glob"],
		});

		const activeTools = session.getActiveToolNames();
		expect(activeTools).toContain("glob");
		expect(activeTools).not.toContain("find");
	});

	it("activates glob when canonical Claude Code PascalCase tools: ['Glob'] is provided", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			tools: ["Glob"],
		});

		const activeTools = session.getActiveToolNames();
		expect(activeTools).toContain("glob");
		expect(activeTools).not.toContain("find");
	});

	it("resolves Claude Code canonical tool names (Bash, Grep, Read, Edit, Write, Glob)", async () => {
		expect(createToolDefinition("Bash", cwd).name).toBe("bash");
		expect(createToolDefinition("Grep", cwd).name).toBe("grep");
		expect(createToolDefinition("Read", cwd).name).toBe("read");
		expect(createToolDefinition("Edit", cwd).name).toBe("edit");
		expect(createToolDefinition("Write", cwd).name).toBe("write");
		expect(createToolDefinition("Glob", cwd).name).toBe("glob");

		expect(createTool("Bash", cwd).name).toBe("bash");
		expect(createTool("Grep", cwd).name).toBe("grep");
		expect(createTool("Read", cwd).name).toBe("read");
		expect(createTool("Edit", cwd).name).toBe("edit");
		expect(createTool("Write", cwd).name).toBe("write");
		expect(createTool("Glob", cwd).name).toBe("glob");

		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			tools: ["Bash", "Grep", "Read", "Edit", "Write", "Glob"],
		});

		const activeTools = session.getActiveToolNames();
		expect(activeTools).toEqual(expect.arrayContaining(["bash", "grep", "read", "edit", "write", "glob"]));
	});
});
