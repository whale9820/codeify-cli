import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "codeify-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("background_task integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("waits without extra model calls when the agent yields for a required result", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["background_task"] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("background_task", {
						action: "start",
						command: "while [ ! -f release ]; do sleep 0.01; done; echo bg-done",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Waiting for the required check."),
			fauxAssistantMessage("The check passed."),
		]);
		let settled = false;
		const pending = harness.session.prompt("run the check and wait for its result").then(() => {
			settled = true;
		});
		await vi.waitFor(() => expect(harness.eventsOfType("agent_end")).toHaveLength(1));

		expect(settled).toBe(false);
		expect(harness.session.isIdle).toBe(false);
		expect(harness.session.getBackgroundTasks()[0]?.status).toBe("running");
		expect(harness.getPendingResponseCount()).toBe(1);
		writeFileSync(join(harness.tempDir, "release"), "");
		await pending;

		expect(harness.session.getLastAssistantText()).toBe("The check passed.");
		expect(harness.session.isIdle).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.eventsOfType("tool_execution_start")).toHaveLength(1);
	});

	it.each([
		{ command: "echo early-result", status: "completed" },
		{ command: "echo early-result; exit 1", status: "failed" },
	])("delivers $status results before the next working response", async ({ command, status }) => {
		const harness = await createHarness({ initialActiveToolNames: ["background_task", "bash"] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("background_task", { action: "start", command })], {
				stopReason: "toolUse",
			}),
			async () => {
				await vi.waitFor(() => expect(harness.session.getBackgroundTasks()[0]?.status).toBe(status));
				return fauxAssistantMessage([fauxToolCall("bash", { command: "echo foreground-result" })], {
					stopReason: "toolUse",
				});
			},
			() => {
				const reportIndex = harness.session.messages.findIndex(
					(message) => message.role === "custom" && message.customType === "background_task",
				);
				expect(reportIndex).toBeGreaterThan(0);
				expect(getMessageText(harness.session.messages[reportIndex])).toContain("early-result");
				expect(getMessageText(harness.session.messages[reportIndex])).toContain(status);
				expect(harness.session.messages[reportIndex - 1]?.role).toBe("toolResult");
				expect(getMessageText(harness.session.messages[reportIndex - 1])).toContain("foreground-result");
				return fauxAssistantMessage("finished with the background result included");
			},
		]);

		await harness.session.prompt("run a background check while continuing work");

		expect(harness.session.getLastAssistantText()).toBe("finished with the background result included");
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("reports a finished task back to the agent and triggers a new turn", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["background_task"] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("background_task", { action: "start", command: "echo bg-done" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("started it"),
			fauxAssistantMessage("saw the result"),
		]);

		await harness.session.prompt("run it in the background");

		await new Promise<void>((resolve, reject) => {
			const deadline = setTimeout(() => reject(new Error("no completion turn")), 8000);
			const check = () => {
				if (harness.session.messages.some((m) => getMessageText(m) === "saw the result")) {
					clearTimeout(deadline);
					resolve();
				} else {
					setTimeout(check, 25);
				}
			};
			check();
		});

		const report = harness.session.messages.find(
			(message) => message.role === "custom" && message.customType === "background_task",
		);
		expect(report).toBeDefined();
		expect(getMessageText(report)).toContain("completed");
		expect(getMessageText(report)).toContain("bg-done");
		expect(harness.session.getBackgroundTasks()[0]?.status).toBe("completed");
		expect(harness.eventsOfType("background_tasks_updated").length).toBeGreaterThanOrEqual(2);
	});
});
