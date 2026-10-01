import { fauxAssistantMessage, fauxToolCall } from "codeify-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("background_task integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
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
