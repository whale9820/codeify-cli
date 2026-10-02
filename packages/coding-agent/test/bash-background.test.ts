import { describe, expect, it } from "vitest";
import { BackgroundTaskManager } from "../src/core/background-tasks.ts";
import { type BashBackgroundHost, createBashToolDefinition } from "../src/core/tools/bash.ts";

function createHost(manager: BackgroundTaskManager) {
	let request: () => void = () => {};
	const host: BashBackgroundHost = {
		watch: () => ({
			requested: new Promise<void>((resolve) => {
				request = resolve;
			}),
			dispose: () => {},
		}),
		adopt: (options) => manager.adopt(options),
	};
	return { host, background: () => request() };
}

describe("bash tool moved to the background", () => {
	it("returns immediately with a task id while the command keeps running", async () => {
		const manager = new BackgroundTaskManager(() => {});
		const { host, background } = createHost(manager);
		const tool = createBashToolDefinition(process.cwd(), { background: host });
		const controller = new AbortController();

		const pending = tool.execute(
			"call",
			{ command: "echo first; sleep 1; echo second" },
			controller.signal,
			undefined,
			undefined as never,
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		background();
		const result = await pending;
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("moved this command to the background as task bg1");
		expect(text).toContain("first");

		// Aborting the agent turn must not kill the backgrounded command.
		controller.abort();
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const task = manager.get("bg1");
		expect(task?.status).toBe("completed");
		expect(manager.readOutput("bg1")?.text).toContain("second");
	});

	it("runs normally when it is never backgrounded", async () => {
		const manager = new BackgroundTaskManager(() => {});
		const { host } = createHost(manager);
		const tool = createBashToolDefinition(process.cwd(), { background: host });
		const result = await tool.execute("call", { command: "echo hi" }, undefined, undefined, undefined as never);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("hi") });
		expect(manager.list()).toEqual([]);
	});
});
