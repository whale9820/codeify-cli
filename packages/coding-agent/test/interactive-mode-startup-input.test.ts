import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	handleSmartModelsCommand: (text: string) => void;
	handleThinkingCommand: (text: string) => void;
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type ThinkingCommandContext = {
	applyThinkingLevel: (level: ThinkingLevel) => void;
	footer: { invalidate: () => void };
	session: {
		thinkingLevel: ThinkingLevel;
		getAvailableThinkingLevels: () => ThinkingLevel[];
		setThinkingLevel: (level: ThinkingLevel) => void;
	};
	showError: (message: string) => void;
	showStatus: (message: string) => void;
	showThinkingSelector: () => void;
	updateEditorBorderColor: () => void;
};

type SmartModelsCommandContext = {
	session: {
		smartModelUsageEnabled: boolean;
		setSmartModelUsageEnabled: (enabled: boolean) => void;
	};
	showError: (message: string) => void;
	showStatus: (message: string) => void;
};

type InputContext = {
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<string>;
	handleThinkingCommand(this: ThinkingCommandContext, text: string): void;
	handleSmartModelsCommand(this: SmartModelsCommandContext, text: string): void;
	applyThinkingLevel(this: ThinkingCommandContext, level: ThinkingLevel): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	return {
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
		},
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
		},
		flushPendingBashComponents: vi.fn(),
		handleSmartModelsCommand: vi.fn(),
		handleThinkingCommand: vi.fn(),
		pendingUserInputs: [],
	};
}

function createSmartModelsCommandContext(): SmartModelsCommandContext {
	const session = {
		smartModelUsageEnabled: false,
		setSmartModelUsageEnabled: vi.fn((enabled: boolean) => {
			session.smartModelUsageEnabled = enabled;
		}),
	};
	return {
		session,
		showError: vi.fn(),
		showStatus: vi.fn(),
	};
}

function createThinkingCommandContext(availableLevels: ThinkingLevel[]): ThinkingCommandContext {
	const session = {
		thinkingLevel: "medium" as ThinkingLevel,
		getAvailableThinkingLevels: () => availableLevels,
		setThinkingLevel: vi.fn((level: ThinkingLevel) => {
			session.thinkingLevel = level;
		}),
	};
	return {
		applyThinkingLevel: interactiveModePrototype.applyThinkingLevel,
		footer: { invalidate: vi.fn() },
		session,
		showError: vi.fn(),
		showStatus: vi.fn(),
		showThinkingSelector: vi.fn(),
		updateEditorBorderColor: vi.fn(),
	};
}

describe("InteractiveMode startup input", () => {
	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs).toEqual(["early prompt"]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingUserInputs: ["queued prompt"],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("queued prompt");
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});

	it.each(["/thinking", "/effort"])("routes %s to the thinking command handler", async (command) => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(command);

		expect(context.handleThinkingCommand).toHaveBeenCalledWith(command);
		expect(context.editor.setText).toHaveBeenCalledWith("");
	});

	it("exposes only /smart for smart model usage", () => {
		const commandNames = BUILTIN_SLASH_COMMANDS.map((command) => command.name);

		expect(commandNames).toContain("smart");
		expect(commandNames).not.toContain("smart-models");
	});

	it("routes /smart to the smart models command handler", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/smart on");

		expect(context.handleSmartModelsCommand).toHaveBeenCalledWith("/smart on");
		expect(context.editor.setText).toHaveBeenCalledWith("");
	});

	it("enables smart model usage through /smart", () => {
		const context = createSmartModelsCommandContext();

		interactiveModePrototype.handleSmartModelsCommand.call(context, "/smart on");

		expect(context.session.setSmartModelUsageEnabled).toHaveBeenCalledWith(true);
		expect(context.showStatus).toHaveBeenCalledWith("Smart model usage: on");
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("reports smart model usage through /smart", () => {
		const context = createSmartModelsCommandContext();

		interactiveModePrototype.handleSmartModelsCommand.call(context, "/smart");

		expect(context.showStatus).toHaveBeenCalledWith("Smart model usage: off");
		expect(context.session.setSmartModelUsageEnabled).not.toHaveBeenCalled();
	});

	it("sets an available thinking level through either command", () => {
		const context = createThinkingCommandContext(["off", "low", "medium", "high", "xhigh"]);

		interactiveModePrototype.handleThinkingCommand.call(context, "/effort xhigh");

		expect(context.session.setThinkingLevel).toHaveBeenCalledWith("xhigh");
		expect(context.footer.invalidate).toHaveBeenCalledTimes(1);
		expect(context.updateEditorBorderColor).toHaveBeenCalledTimes(1);
		expect(context.showStatus).toHaveBeenCalledWith("Thinking level: xhigh");
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("opens the selector without an explicit level", () => {
		const context = createThinkingCommandContext(["off", "low", "medium", "high"]);

		interactiveModePrototype.handleThinkingCommand.call(context, "/thinking");

		expect(context.showThinkingSelector).toHaveBeenCalledTimes(1);
		expect(context.session.setThinkingLevel).not.toHaveBeenCalled();
	});

	it("rejects unsupported thinking levels", () => {
		const context = createThinkingCommandContext(["off", "low", "medium", "high"]);

		interactiveModePrototype.handleThinkingCommand.call(context, "/thinking max");

		expect(context.showError).toHaveBeenCalledWith(
			"Invalid thinking level. Available levels: off, low, medium, high",
		);
		expect(context.session.setThinkingLevel).not.toHaveBeenCalled();
	});
});
