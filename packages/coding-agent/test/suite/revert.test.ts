import { fauxAssistantMessage } from "codeify-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("revertLastTurn", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("returns undefined when there is no user message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		expect(await harness.session.revertLastTurn()).toBeUndefined();
	});

	it("rewinds before the last user prompt and returns its text", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("crazy reply")]);

		await harness.session.prompt("first prompt");
		await harness.session.prompt("second prompt");
		expect(harness.session.messages).toHaveLength(4);

		const result = await harness.session.revertLastTurn();

		expect(result?.editorText).toBe("second prompt");
		expect(harness.session.messages).toHaveLength(2);
		expect(harness.session.messages[0].role).toBe("user");
		expect(harness.session.messages[1].role).toBe("assistant");
	});

	it("pauses an active goal", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("reply")]);
		harness.session.setGoal("ship it");

		await harness.session.prompt("go");
		await harness.session.revertLastTurn();

		expect(harness.session.getGoal()?.status).toBe("paused");
	});

	it("walks up one user message each time it is repeated", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first reply"),
			fauxAssistantMessage("second reply"),
			fauxAssistantMessage("third reply"),
		]);

		await harness.session.prompt("first prompt");
		await harness.session.prompt("second prompt");
		await harness.session.prompt("third prompt");

		const third = await harness.session.revertLastTurn();
		expect(third?.editorText).toBe("third prompt");
		expect(harness.session.messages).toHaveLength(4);

		const second = await harness.session.revertLastTurn();
		expect(second?.editorText).toBe("second prompt");
		expect(harness.session.messages).toHaveLength(2);
		expect(harness.session.messages[0].role).toBe("user");
		expect(harness.session.messages[1].role).toBe("assistant");

		const first = await harness.session.revertLastTurn();
		expect(first?.editorText).toBe("first prompt");
		expect(harness.session.messages).toHaveLength(0);

		expect(await harness.session.revertLastTurn()).toBeUndefined();
	});

	it("does not revert a user message that is off the active branch", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

		await harness.session.prompt("first prompt");
		await harness.session.prompt("second prompt");
		const first = harness.session.getBranchUserMessages()[0];
		if (!first) throw new Error("expected a user message");

		await harness.session.navigateTree(first.entryId);
		expect(harness.session.messages).toHaveLength(0);
		expect(harness.session.getUserMessagesForForking().map((message) => message.text)).toEqual([
			"first prompt",
			"second prompt",
		]);

		expect(await harness.session.revertLastTurn()).toBeUndefined();
		expect(harness.session.messages).toHaveLength(0);
	});
});
