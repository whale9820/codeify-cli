import { fauxAssistantMessage, fauxToolCall } from "codeify-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

function toolResultText(harness: Harness): string {
	const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
	const block = (toolResult as { content: Array<{ type: string; text?: string }> }).content.find(
		(part) => part.type === "text",
	);
	return block?.text ?? "";
}

describe("goal", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("registers update_goal as an active tool by default", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		expect(harness.session.getActiveToolNames()).toContain("update_goal");
	});

	it("tracks pause, resume and clear transitions", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		expect(harness.session.pauseGoal()).toBe(false);
		harness.session.setGoal("ship it");
		expect(harness.session.getGoal()?.status).toBe("active");

		harness.session.recordGoalContinuation(true);
		expect(harness.session.getGoal()?.continuations).toBe(1);
		expect(harness.session.getGoal()?.stalls).toBe(1);

		expect(harness.session.pauseGoal()).toBe(true);
		expect(harness.session.getGoal()?.status).toBe("paused");
		expect(harness.session.resumeGoal()).toBe(true);
		expect(harness.session.getGoal()?.status).toBe("active");
		expect(harness.session.getGoal()?.continuations).toBe(0);
		expect(harness.session.getGoal()?.stalls).toBe(0);

		expect(harness.session.clearGoal()).toBe(true);
		expect(harness.session.getGoal()).toBeUndefined();
		expect(harness.session.clearGoal()).toBe(false);
		expect(harness.eventsOfType("goal_updated")).toHaveLength(4);
	});

	it("completes the active goal when the model calls update_goal", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.session.setGoal("make tests pass");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete", summary: "all green" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const goal = harness.session.getGoal();
		expect(goal?.status).toBe("complete");
		expect(goal?.summary).toBe("all green");
		expect(toolResultText(harness)).toContain("Goal marked complete");
		const updates = harness.eventsOfType("goal_updated");
		expect(updates.at(-1)?.goal?.status).toBe("complete");
	});

	it("ignores update_goal when no goal is active", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(toolResultText(harness)).toContain("no active goal");
		expect(harness.eventsOfType("goal_updated")).toHaveLength(0);
	});

	it("does not let a paused goal be completed", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.session.setGoal("paused work");
		harness.session.pauseGoal();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(harness.session.getGoal()?.status).toBe("paused");
	});
});
