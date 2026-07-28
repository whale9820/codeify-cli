import { fauxAssistantMessage, fauxToolCall } from "codeify-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("context_usage session integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("registers context_usage as an active tool by default", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		expect(harness.session.getActiveToolNames()).toContain("context_usage");
	});

	it("reports real session context when the model calls it", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("context_usage", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("how much context are we using?");

		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(toolResult).toBeDefined();
		const text = (toolResult as { content: Array<{ type: string; text?: string }> }).content.find(
			(block) => block.type === "text",
		);
		expect(text?.text).toContain("Context:");
		expect(text?.text).toContain("Turns on this branch:");
	});

	it("emits a compaction request without compacting on its own", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("context_usage", { request_compaction: true })], { stopReason: "toolUse" }),
			fauxAssistantMessage("asked the user"),
		]);

		await harness.session.prompt("we are deep in this session");

		expect(harness.eventsOfType("compaction_requested")).toHaveLength(1);
		// The model cannot compact by itself; approval happens in the host.
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);

		const rationale = harness.session.takePendingCompactionRequest();
		expect(rationale).toBeDefined();
		// The request is consumed once, so a stale approval cannot fire later.
		expect(harness.session.takePendingCompactionRequest()).toBeUndefined();
	});

	it("leaves no pending request when the model only reads usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("context_usage", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("check usage");

		expect(harness.eventsOfType("compaction_requested")).toHaveLength(0);
		expect(harness.session.takePendingCompactionRequest()).toBeUndefined();
	});
});
