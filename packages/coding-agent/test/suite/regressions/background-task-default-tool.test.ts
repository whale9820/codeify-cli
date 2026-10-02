import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "codeify-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../../../src/index.ts";

// The CLI builds its session through createAgentSession, which decides the initial active tools.
// background_task was registered but never activated there, so the model never saw it.
describe("background_task default activation", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `bg-default-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("is active by default and described in the system prompt", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const { session } = await createAgentSession({ cwd, agentDir, model: model! });

		expect(session.getActiveToolNames()).toContain("background_task");
		expect(session.systemPrompt).toContain("background_task");
		expect(session.systemPrompt).toContain("/tasks");
		expect(session.systemPrompt).toContain("Ctrl+B");
	});

	it("can be excluded", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const { session } = await createAgentSession({ cwd, agentDir, model: model!, excludeTools: ["background_task"] });

		expect(session.getActiveToolNames()).not.toContain("background_task");
	});
});
