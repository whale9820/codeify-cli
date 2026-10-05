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
