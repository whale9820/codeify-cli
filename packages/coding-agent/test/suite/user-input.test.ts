import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "codeify-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("request_user_input integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("waits for explicit answers before later tools and model calls", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["bash"] });
		harnesses.push(harness);
		harness.session.setUserInputEnabled();
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("request_user_input", {
						questions: [
							{ question: "Which destination?", options: ["Local", "Remote"] },
							{ question: "What name?" },
						],
					}),
					fauxToolCall("bash", { command: "touch answered" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Answers received."),
		]);
		const pending = harness.session.prompt("ask before acting");
		await vi.waitFor(() => expect(harness.session.getPendingUserInput()).toBeDefined());
		const request = harness.session.getPendingUserInput()!;
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(existsSync(join(harness.tempDir, "answered"))).toBe(false);
		expect(harness.eventsOfType("user_input_requested")).toHaveLength(1);
		expect(() => harness.session.answerUserInput(request.id, ["", "name"])).toThrow("nonempty");
		expect(() => harness.session.answerUserInput("stale", ["Local", "name"])).toThrow("expired");
		expect(() => harness.session.answerUserInput(request.id, ["Local"])).toThrow("every question");
		expect(harness.session.getPendingUserInput()).toEqual(request);
		harness.session.answerUserInput(request.id, ["Custom destination", " project "]);
		await pending;
		expect(harness.session.getPendingUserInput()).toBeUndefined();
		expect(existsSync(join(harness.tempDir, "answered"))).toBe(true);
		const result = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "request_user_input",
		);
		expect(result).toBeDefined();
		expect(getMessageText(result)).toContain('"answers":["Custom destination","project"]');
		expect(harness.session.getLastAssistantText()).toBe("Answers received.");
		expect(() => harness.session.answerUserInput(request.id, ["Local", "name"])).toThrow("expired");
	});

	it("cancels without treating silence as an answer or running dependent tools", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["bash"] });
		harnesses.push(harness);
		harness.session.setUserInputEnabled();
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("request_user_input", { questions: [{ question: "Approve?", options: ["Yes", "No"] }] }),
					fauxToolCall("bash", { command: "touch approved" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Should not run."),
		]);
		const pending = harness.session.prompt("wait for approval");
		await vi.waitFor(() => expect(harness.session.getPendingUserInput()).toBeDefined());
		await harness.session.abort();
		await pending;
		expect(harness.session.getPendingUserInput()).toBeUndefined();
		expect(existsSync(join(harness.tempDir, "approved"))).toBe(false);
		expect(harness.session.getLastAssistantText()).not.toBe("Should not run.");
	});

	it("does not enable questions in headless sessions or when tools are disabled", async () => {
		const harness = await createHarness({ initialActiveToolNames: [] });
		harnesses.push(harness);
		expect(harness.session.getActiveToolNames()).not.toContain("request_user_input");
		harness.session.setUserInputEnabled();
		expect(harness.session.getActiveToolNames()).toEqual([]);
	});
});
