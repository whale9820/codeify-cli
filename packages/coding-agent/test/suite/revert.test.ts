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
});
