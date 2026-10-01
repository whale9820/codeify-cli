import { describe, expect, it, vi } from "vitest";
import { type BackgroundTask, BackgroundTaskManager, buildCompletionMessage } from "../src/core/background-tasks.ts";
import { createBackgroundTaskToolDefinition } from "../src/core/tools/background-task.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("BackgroundTaskManager", () => {
	it("returns immediately and reports when the task finishes", async () => {
		const finished = vi.fn<(task: BackgroundTask) => void>();
		const manager = new BackgroundTaskManager(finished);
		const gate = deferred<{ exitCode: number }>();
		const task = manager.start({
			kind: "command",
			description: "build",
			run: async ({ append }) => {
				append("hello\n");
				return gate.promise;
			},
		});

		expect(task.status).toBe("running");
		expect(finished).not.toHaveBeenCalled();
		expect(manager.readOutput(task.id)?.text).toBe("hello\n");

		gate.resolve({ exitCode: 0 });
		await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
		expect(finished.mock.calls[0][0].status).toBe("completed");
		expect(manager.get(task.id)?.status).toBe("completed");
	});

	it("marks non-zero exits and thrown errors as failed", async () => {
		const finished = vi.fn<(task: BackgroundTask) => void>();
		const manager = new BackgroundTaskManager(finished);
		manager.start({ kind: "command", description: "a", run: async () => ({ exitCode: 2 }) });
		manager.start({
			kind: "command",
			description: "b",
			run: async () => {
				throw new Error("boom");
			},
		});

		await vi.waitFor(() => expect(finished).toHaveBeenCalledTimes(2));
		const statuses = finished.mock.calls.map((call) => call[0].status);
		expect(statuses).toEqual(["failed", "failed"]);
		expect(finished.mock.calls[1][0].error).toBe("boom");
	});

	it("stops a running task via its abort signal", async () => {
		const finished = vi.fn<(task: BackgroundTask) => void>();
		const manager = new BackgroundTaskManager(finished);
		const task = manager.start({
			kind: "command",
			description: "sleep",
			run: ({ signal }) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		});

		expect(manager.stop(task.id)).toBe(true);
		await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
		expect(manager.get(task.id)?.status).toBe("stopped");
		expect(manager.stop(task.id)).toBe(false);
	});

	it("caps retained output and reports dropped characters", () => {
		const manager = new BackgroundTaskManager(() => {});
		const task = manager.start({
			kind: "command",
			description: "noisy",
			run: async ({ append }) => {
				append("x".repeat(70_000));
				return new Promise(() => {});
			},
		});

		const output = manager.readOutput(task.id);
		expect(output?.text.length).toBe(64_000);
		expect(output?.droppedChars).toBe(6_000);
	});

	it("limits concurrent tasks", () => {
		const manager = new BackgroundTaskManager(() => {});
		for (let index = 0; index < 8; index++) {
			manager.start({ kind: "command", description: "x", run: () => new Promise(() => {}) });
		}
		expect(() => manager.start({ kind: "command", description: "x", run: () => new Promise(() => {}) })).toThrow(
			/At most 8/,
		);
	});

	it("builds a completion message with output", () => {
		const message = buildCompletionMessage(
			{
				id: "bg1",
				kind: "command",
				description: "tests",
				status: "failed",
				startedAt: 0,
				endedAt: 1000,
				exitCode: 1,
			},
			{ text: "FAIL a.test.ts\n", droppedChars: 0 },
		);
		expect(message).toContain("bg1");
		expect(message).toContain("failed exit 1");
		expect(message).toContain("FAIL a.test.ts");
	});
});

describe("background_task tool", () => {
	function setup() {
		const task: BackgroundTask = { id: "bg1", kind: "command", description: "x", status: "running", startedAt: 0 };
		const ops = {
			startCommand: vi.fn(() => task),
			list: vi.fn(() => [task]),
			get: vi.fn((id: string) => (id === "bg1" ? task : undefined)),
			readOutput: vi.fn(() => ({ text: "out", droppedChars: 0 })),
			stop: vi.fn(() => true),
		};
		const definition = createBackgroundTaskToolDefinition(ops);
		const run = async (params: Parameters<typeof definition.execute>[1]) => {
			const result = await definition.execute("call", params, undefined, undefined, { cwd: process.cwd() });
			const block = result.content.find((item) => item.type === "text");
			return block?.type === "text" ? block.text : "";
		};
		return { ops, run };
	}

	it("starts a command and tells the agent not to wait", async () => {
		const { ops, run } = setup();
		const text = await run({ action: "start", command: "npm test" });

		expect(ops.startCommand).toHaveBeenCalledWith("npm test", "npm test", undefined);
		expect(text).toContain("bg1");
		expect(text).toContain("do not wait");
	});

	it("rejects start without a command or task", async () => {
		const { run } = setup();
		await expect(run({ action: "start" })).rejects.toThrow(/command or a task/);
	});

	it("rejects agent tasks when delegation is unavailable", async () => {
		const { run } = setup();
		await expect(run({ action: "start", task: "look around", model: "m" })).rejects.toThrow(/unavailable/);
	});

	it("reads output and stops by id", async () => {
		const { ops, run } = setup();
		expect(await run({ action: "output", id: "bg1" })).toContain("out");
		await run({ action: "stop", id: "bg1" });
		expect(ops.stop).toHaveBeenCalledWith("bg1");
		await expect(run({ action: "output", id: "nope" })).rejects.toThrow(/Unknown/);
	});
});
