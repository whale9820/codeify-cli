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
		mode.showInputDialog
			.mockResolvedValueOnce("")
			.mockResolvedValueOnce(" ")
			.mockResolvedValueOnce("my custom answer");
		await handleRequest.call(mode, {
			id: "q1",
			questions: [
				{ question: "Destination?", options: ["Local", "Remote"] },
				{ question: "Name?", options: ["First", "Second"] },
			],
		});
		expect(mode.session.answerUserInput).toHaveBeenCalledWith("q1", ["Remote", "my custom answer"]);
		expect(mode.showInputDialog).toHaveBeenCalledTimes(3);
		expect(mode.session.abort).not.toHaveBeenCalled();
	});

	it("waits for extra text after selecting a choice and submits both together", async () => {
		const mode = createMode();
		mode.showDialogSelector.mockResolvedValue("2. Remote");
		let submitDetails: ((value: string) => void) | undefined;
		mode.showInputDialog.mockImplementation(
			() =>
				new Promise((resolve) => {
					submitDetails = resolve;
				}),
		);
		const pending = handleRequest.call(mode, {
			id: "q-details",
			questions: [{ question: "Destination?", options: ["Local", "Remote"] }],
		});
		await vi.waitFor(() => expect(mode.showInputDialog).toHaveBeenCalled());
		expect(mode.session.answerUserInput).not.toHaveBeenCalled();
		expect(mode.showInputDialog.mock.calls[0]?.[0]).toContain("Selected: Remote");
		submitDetails?.("  Use the staging server, not production.  ");
		await pending;
		expect(mode.session.answerUserInput).toHaveBeenCalledWith("q-details", [
			"Remote\nUse the staging server, not production.",
		]);
	});

	it.each(["", "   "])("submits just the selected choice when optional details are %j", async (details) => {
		const mode = createMode();
		mode.showDialogSelector.mockResolvedValue("1. Local");
		mode.showInputDialog.mockResolvedValue(details);
		await handleRequest.call(mode, {
			id: "q-choice",
			questions: [{ question: "Destination?", options: ["Local", "Remote"] }],
		});
		expect(mode.session.answerUserInput).toHaveBeenCalledWith("q-choice", ["Local"]);
		expect(mode.session.abort).not.toHaveBeenCalled();
	});

	it("cancels during optional details without submitting selected choices", async () => {
		const mode = createMode();
		mode.showDialogSelector.mockResolvedValue("1. Local");
		mode.showInputDialog.mockResolvedValueOnce("Use staging").mockResolvedValueOnce(undefined);
		await handleRequest.call(mode, {
			id: "q-details-cancel",
			questions: [
				{ question: "Destination?", options: ["Local", "Remote"] },
				{ question: "Account?", options: ["Local", "Remote"] },
			],
		});
		expect(mode.session.abort).toHaveBeenCalledTimes(1);
		expect(mode.session.answerUserInput).not.toHaveBeenCalled();
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
