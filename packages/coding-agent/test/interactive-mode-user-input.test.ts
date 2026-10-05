import { beforeAll, describe, expect, it, vi } from "vitest";
import type { UserInputRequest } from "../src/core/user-input.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function createMode() {
	return {
		session: {
			agent: { signal: new AbortController().signal },
			isStreaming: false,
			answerUserInput: vi.fn(),
			abort: vi.fn(async () => {}),
		},
		clearStatusIndicator: vi.fn(),
		statusContainer: { addChild: vi.fn(), clear: vi.fn() },
		ui: { requestRender: vi.fn() },
		showDialogSelector: vi.fn<(...args: unknown[]) => Promise<string | undefined>>(),
		showInputDialog: vi.fn<(...args: unknown[]) => Promise<string | undefined>>(),
		showError: vi.fn(),
	};
}

const handleRequest = Reflect.get(InteractiveMode.prototype, "handleUserInputRequest") as (
	this: ReturnType<typeof createMode>,
	request: UserInputRequest,
) => Promise<void>;

describe("InteractiveMode questions", () => {
	beforeAll(() => initTheme("dark"));
	it("collects a selected answer and custom text while rejecting blank submissions", async () => {
		const mode = createMode();
		mode.showDialogSelector.mockResolvedValueOnce("2. Remote").mockResolvedValueOnce("Type your own answer");
		mode.showInputDialog.mockResolvedValueOnce(" ").mockResolvedValueOnce("my custom answer");
		await handleRequest.call(mode, {
			id: "q1",
			questions: [
				{ question: "Destination?", options: ["Local", "Remote"] },
				{ question: "Name?", options: ["First", "Second"] },
			],
		});
		expect(mode.session.answerUserInput).toHaveBeenCalledWith("q1", ["Remote", "my custom answer"]);
		expect(mode.showInputDialog).toHaveBeenCalledTimes(2);
		expect(mode.session.abort).not.toHaveBeenCalled();
	});

	it("supports a free text question", async () => {
		const mode = createMode();
		mode.showInputDialog.mockResolvedValue("my answer");
		await handleRequest.call(mode, { id: "q2", questions: [{ question: "What name?" }] });
		expect(mode.showDialogSelector).not.toHaveBeenCalled();
		expect(mode.session.answerUserInput).toHaveBeenCalledWith("q2", ["my answer"]);
	});

	it.each([true, false])("cancels a question with options=%s without submitting an answer", async (options) => {
		const mode = createMode();
		mode.showDialogSelector.mockResolvedValue(undefined);
		mode.showInputDialog.mockResolvedValue(undefined);
		await handleRequest.call(mode, {
			id: "q3",
			questions: [{ question: "Approve?", options: options ? ["Yes", "No"] : undefined }],
		});
		expect(mode.session.abort).toHaveBeenCalledTimes(1);
		expect(mode.session.answerUserInput).not.toHaveBeenCalled();
	});
});
