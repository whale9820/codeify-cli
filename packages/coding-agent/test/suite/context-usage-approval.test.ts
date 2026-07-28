import { fauxAssistantMessage, fauxToolCall } from "codeify-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("context_usage compaction approval", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("compacts when the request is approved, keeping the session usable", async () => {
		// keepRecentTokens must be small enough that a short test session has history to cut.
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);

		// Build enough history that there is something to compact.
		harness.setResponses([
			fauxAssistantMessage("first"),
			fauxAssistantMessage("second"),
			fauxAssistantMessage([fauxToolCall("context_usage", { request_compaction: true })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("asked the user"),
			fauxAssistantMessage("summary of earlier work"),
			fauxAssistantMessage("after compaction"),
		]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		await harness.session.prompt("three");

		const rationale = harness.session.takePendingCompactionRequest();
		expect(rationale).toBeDefined();

		// This is what the host does on approval.
		await harness.session.compact();

		const starts = harness.eventsOfType("compaction_start");
		expect(starts).toHaveLength(1);
		expect(starts[0].reason).toBe("manual");

		const ends = harness.eventsOfType("compaction_end");
		expect(ends).toHaveLength(1);
		expect(ends[0].aborted).toBe(false);
		expect(ends[0].errorMessage).toBeUndefined();

		// The session still works after compacting.
		await harness.session.prompt("what now?");
		const last = harness.session.messages[harness.session.messages.length - 1];
		expect(last.role).toBe("assistant");
	});

	it("leaves the session untouched when the request is declined", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("context_usage", { request_compaction: true })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("asked the user"),
			fauxAssistantMessage("carrying on"),
		]);

		await harness.session.prompt("check context");

		// Declining means taking the request and not calling compact().
		expect(harness.session.takePendingCompactionRequest()).toBeDefined();

		await harness.session.prompt("keep going");

		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.session.messages.some((message) => message.role === "compactionSummary")).toBe(false);
	});
});
