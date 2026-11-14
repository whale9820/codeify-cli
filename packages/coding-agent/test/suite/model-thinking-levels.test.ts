import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("per-model thinking levels", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("restores the level last used with each model when switching", async () => {
		harness = await createHarness({
			models: [
				{ id: "model-a", reasoning: true },
				{ id: "model-b", reasoning: true },
			],
		});
		const modelA = harness.getModel("model-a")!;
		const modelB = harness.getModel("model-b")!;
		const { session, settingsManager } = harness;

		await session.setModel(modelB);
		session.setThinkingLevel("low");

		await session.setModel(modelA);
		session.setThinkingLevel("high");

		await session.setModel(modelB);
		expect(session.thinkingLevel).toBe("low");

		await session.setModel(modelA);
		expect(session.thinkingLevel).toBe("high");

		expect(settingsManager.getModelThinkingLevel(modelA.provider, modelA.id)).toBe("high");
		expect(settingsManager.getModelThinkingLevel(modelB.provider, modelB.id)).toBe("low");
	});

	it("inherits the current level for a model without a saved level", async () => {
		harness = await createHarness({
			models: [
				{ id: "model-a", reasoning: true },
				{ id: "model-b", reasoning: true },
			],
		});
		const { session } = harness;

		await session.setModel(harness.getModel("model-a")!);
		session.setThinkingLevel("medium");

		await session.setModel(harness.getModel("model-b")!);
		expect(session.thinkingLevel).toBe("medium");
	});

	it("uses the saved level when cycling models", async () => {
		harness = await createHarness({
			models: [
				{ id: "model-a", reasoning: true },
				{ id: "model-b", reasoning: true },
			],
		});
		const { session } = harness;

		await session.setModel(harness.getModel("model-b")!);
		session.setThinkingLevel("minimal");
		await session.setModel(harness.getModel("model-a")!);
		session.setThinkingLevel("high");

		const result = await session.cycleModel("forward");
		expect(result?.model.id).toBe("model-b");
		expect(session.thinkingLevel).toBe("minimal");
	});
});
