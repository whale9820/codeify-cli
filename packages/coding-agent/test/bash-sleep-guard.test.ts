import { describe, expect, it, vi } from "vitest";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";

describe("bash sleep guard", () => {
	it.each([
		"sleep 30",
		"/bin/sleep 30",
		"echo ready && sleep 30",
		"echo ready; sleep 30; echo done",
		"echo ready\nsleep 30",
		"while true; do sleep 30; done",
		"env WAIT=30 sleep 30",
		"command sleep 30",
		"exec sleep 30",
		"'sleep' 30",
		"slee\\p 30",
		"(sleep 30)",
		"echo $(sleep 30)",
	])("blocks %s before executing any part of the command", async (command) => {
		const exec = vi.fn(async () => ({ exitCode: 0 }));
		const tool = createBashToolDefinition(process.cwd(), {
			operations: { exec },
			hasRunningBackgroundTasks: () => true,
		});
		await expect(tool.execute("call", { command }, undefined, undefined, undefined as never)).rejects.toThrow(
			"Just end your turn rather than waiting: the task will ping you automatically",
		);
		expect(exec).not.toHaveBeenCalled();
	});

	it.each([
		"echo sleep 30",
		"printf '%s' 'sleep 30'",
		'echo "sleep 30; sleep 60"',
		"rg sleep file.ts",
		"cat sleep.txt",
		"echo ready # sleep 30",
		"echo ready\n# sleep 30",
		"sleepy 30",
	])("allows %s while background tasks run", async (command) => {
		const exec = vi.fn(async () => ({ exitCode: 0 }));
		const tool = createBashToolDefinition(process.cwd(), {
			operations: { exec },
			hasRunningBackgroundTasks: () => true,
		});
		await tool.execute("call", { command }, undefined, undefined, undefined as never);
		expect(exec).toHaveBeenCalledOnce();
	});

	it("checks current task state on every call and allows sleep after tasks finish", async () => {
		let running = true;
		const exec = vi.fn(async () => ({ exitCode: 0 }));
		const tool = createBashToolDefinition(process.cwd(), {
			operations: { exec },
			hasRunningBackgroundTasks: () => running,
		});
		await expect(
			tool.execute("blocked", { command: "sleep 30" }, undefined, undefined, undefined as never),
		).rejects.toThrow("Sleep blocked");
		running = false;
		await tool.execute("allowed", { command: "sleep 30" }, undefined, undefined, undefined as never);
		expect(exec).toHaveBeenCalledOnce();
	});

	it("allows sleep for standalone tools without background task state", async () => {
		const exec = vi.fn(async () => ({ exitCode: 0 }));
		const tool = createBashToolDefinition(process.cwd(), { operations: { exec } });
		await tool.execute("call", { command: "sleep 30" }, undefined, undefined, undefined as never);
		expect(exec).toHaveBeenCalledOnce();
	});
});
