import type { AssistantMessage } from "codeify-ai";
import type { TUI } from "codeify-tui";
import { describe, expect, test, vi } from "vitest";
import { RetryStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const trailingCommaError =
	"server_tool_stream_failed: JSONDecodeError: Illegal trailing comma before end of array: line 1 column 1705 (char 1704)";

function assistantError(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "codeify",
		model: "gpt-6-astra",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: 0,
	};
}

describe("InteractiveMode server tool stream failures", () => {
	test("removes a retryable JSON decode failure before it renders", async () => {
		const errorComponent = { updateContent: vi.fn() };
		const toolComponent = {};
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			streamingComponent: errorComponent,
			streamingMessage: undefined as AssistantMessage | undefined,
			pendingTools: new Map([["tool-1", toolComponent]]),
			chatContainer: { removeChild: vi.fn() },
			session: {
				hidesRetryingAssistantError: vi.fn(() => true),
			},
			ui: { requestRender: vi.fn() },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: { type: "message_end"; message: AssistantMessage },
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "message_end",
			message: assistantError(trailingCommaError),
		});

		expect(fakeThis.session.hidesRetryingAssistantError).toHaveBeenCalled();
		expect(errorComponent.updateContent).not.toHaveBeenCalled();
		expect(fakeThis.chatContainer.removeChild).toHaveBeenCalledWith(errorComponent);
		expect(fakeThis.chatContainer.removeChild).toHaveBeenCalledWith(toolComponent);
		expect(fakeThis.pendingTools.size).toBe(0);
		expect(fakeThis.streamingComponent).toBeUndefined();
	});

	test("does not print the raw error when summarization retries", async () => {
		initTheme("dark");
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			clearStatusIndicator: vi.fn(),
			clearReconnectingLine: vi.fn(),
			showReconnectingLine: vi.fn(),
			showError: vi.fn(),
			showStatusIndicator: vi.fn(),
			ui,
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "summarization_retry_scheduled";
				attempt: number;
				maxAttempts: number;
				delayMs: number;
				errorMessage: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "summarization_retry_scheduled",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1000,
			errorMessage: trailingCommaError,
		});

		expect(fakeThis.showError).not.toHaveBeenCalled();
		expect(fakeThis.showStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.showStatusIndicator.mock.calls[0]?.[0]).toBeInstanceOf(RetryStatusIndicator);
	});

	test("does not add a second error line after malformed JSON retries are exhausted", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			retryEscapeHandler: undefined as (() => void) | undefined,
			defaultEditor: { onEscape: undefined as (() => void) | undefined },
			clearReconnectingLine: vi.fn(),
			clearStatusIndicator: vi.fn(),
			showError: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string },
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "auto_retry_end",
			success: false,
			attempt: 3,
			finalError: "network unstable please try again",
		});

		expect(fakeThis.showError).not.toHaveBeenCalled();
	});
});
