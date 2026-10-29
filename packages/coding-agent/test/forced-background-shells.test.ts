import { describe, expect, it, vi } from "vitest";
import { BackgroundTaskManager } from "../src/core/background-tasks.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";

function setup(enabled: boolean) {
	const manager = new BackgroundTaskManager(() => {});
	let finish: (result: { exitCode: number | null }) => void = () => {};
	const tool = createBashToolDefinition(process.cwd(), {
		forcedBackgroundShells: () => enabled,
		background: {
			watch: () => ({ requested: new Promise(() => {}), dispose: () => {} }),
			adopt: (options) => manager.adopt(options),
		},
		operations: {
			exec: () =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		},
	});
	return { manager, tool, finish: () => finish({ exitCode: 0 }) };
}

describe("forced background shells", () => {
	it("persists the opt-in setting", async () => {
		const settings = SettingsManager.inMemory();
		expect(settings.getForcedBackgroundShells()).toBe(false);
		settings.setForcedBackgroundShells(true);
		await settings.reload();
		expect(settings.getForcedBackgroundShells()).toBe(true);
	});

	it.each([
		"cd /tmp && timeout 280 python3 -u << 'EOF'\nprint('hi')\nEOF",
		"cd /tmp && timeout 300 python3 << 'EOF'\nprint('hi')\nEOF",
		"timeout 1m python3 script.py",
	])("immediately backgrounds %s", async (command) => {
		const { manager, tool, finish } = setup(true);
		const result = await tool.execute("call", { command }, undefined, undefined, undefined as never);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Automatically moved") });
		expect(manager.get("bg1")?.status).toBe("running");
		finish();
	});

	it("waits for short commands and backgrounds other commands after 10 seconds", async () => {
		vi.useFakeTimers();
		try {
			const { manager, tool, finish } = setup(true);
			const short = tool.execute(
				"short",
				{ command: "echo 'timeout 300 python'" },
				undefined,
				undefined,
				undefined as never,
			);
			await vi.advanceTimersByTimeAsync(9999);
			expect(manager.list()).toEqual([]);
			finish();
			await short;
			const long = tool.execute("long", { command: "python3 script.py" }, undefined, undefined, undefined as never);
			await vi.advanceTimersByTimeAsync(10000);
			expect((await long).content[0]).toMatchObject({ text: expect.stringContaining("Automatically moved") });
			finish();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not automatically background commands when disabled", async () => {
		const { manager, tool, finish } = setup(false);
		const result = tool.execute("call", { command: "timeout 300 python3" }, undefined, undefined, undefined as never);
		await Promise.resolve();
		expect(manager.list()).toEqual([]);
		finish();
		await result;
	});
});
