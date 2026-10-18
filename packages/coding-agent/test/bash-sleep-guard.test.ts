import { describe, expect, it, vi } from "vitest";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";

describe("bash background wait guard", () => {
	it.each([
		"true",
		" true ",
		":",
		"true;",
		"true && :",
		"true\ntrue",
		"/bin/true",
		"command true",
		"builtin :",
		"exec true",
	])("blocks no-op %s before execution while background work is pending", async (command) => {
		const exec = vi.fn(async () => ({ exitCode: 0 }));
		const tool = createBashToolDefinition(process.cwd(), {
			operations: { exec },
			hasPendingBackgroundTasks: () => true,
		});
		await expect(tool.execute("call", { command }, undefined, undefined, undefined as never)).rejects.toThrow(
			"No-op command blocked",
		);
		expect(exec).not.toHaveBeenCalled();
	});

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
			hasPendingBackgroundTasks: () => true,
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
		"true && echo ready",
		"echo true",
		"printf '%s' ':'",
		"true > marker",
		": > marker",
		"while true; do echo ready; break; done",
	])("allows %s while background tasks run", async (command) => {
		const exec = vi.fn(async () => ({ exitCode: 0 }));
		const tool = createBashToolDefinition(process.cwd(), {
			operations: { exec },
			hasPendingBackgroundTasks: () => true,
		});
		await tool.execute("call", { command }, undefined, undefined, undefined as never);
		expect(exec).toHaveBeenCalledOnce();
	});

	it.each(["sleep 30", "true", ":"])("allows %s after pending work is delivered", async (command) => {
		let running = true;
		const exec = vi.fn(async () => ({ exitCode: 0 }));
		const tool = createBashToolDefinition(process.cwd(), {
			operations: { exec },
			hasPendingBackgroundTasks: () => running,
		});
		await expect(tool.execute("blocked", { command }, undefined, undefined, undefined as never)).rejects.toThrow(
			"blocked while a background task",
		);
		running = false;
		await tool.execute("allowed", { command }, undefined, undefined, undefined as never);
		expect(exec).toHaveBeenCalledOnce();
	});

	it.each(["sleep 30", "true", ":"])("allows standalone %s without background task state", async (command) => {
		const exec = vi.fn(async () => ({ exitCode: 0 }));
		const tool = createBashToolDefinition(process.cwd(), { operations: { exec } });
		await tool.execute("call", { command }, undefined, undefined, undefined as never);
		expect(exec).toHaveBeenCalledOnce();
	});
});
