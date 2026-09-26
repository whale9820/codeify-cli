import type { TUI } from "codeify-tui";
import { describe, expect, test, vi } from "vitest";
import { RetryStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("InteractiveMode reconnect status", () => {
	test("replaces a retryable 522 with Reconnecting... (1/5)", async () => {
		const errorComponent = { updateContent: vi.fn() };
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			streamingComponent: errorComponent,
			streamingMessage: undefined as unknown,
			pendingTools: new Map(),
			chatContainer: { removeChild: vi.fn() },
			session: {
				retryAttempt: 0,
				getReconnectAttempt: vi.fn(() => ({ attempt: 1, maxAttempts: 5 })),
			},
			showReconnectingLine: vi.fn(),
			applyCitationSources: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: { type: "message_end"; message: { role: string; stopReason: string; errorMessage: string } },
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "API Error (522): 522 status code (no body)",
			},
		});

		expect(fakeThis.chatContainer.removeChild).toHaveBeenCalledWith(errorComponent);
		expect(fakeThis.showReconnectingLine).toHaveBeenCalledWith(1, 5);
	});

	test("keeps a non-reconnect error in the chat", async () => {
		const errorComponent = { updateContent: vi.fn() };
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			streamingComponent: errorComponent,
			streamingMessage: undefined as unknown,
			pendingTools: new Map(),
			chatContainer: { removeChild: vi.fn() },
			session: {
				retryAttempt: 0,
				getReconnectAttempt: vi.fn(() => undefined),
			},
			showReconnectingLine: vi.fn(),
			applyCitationSources: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: { type: "message_end"; message: { role: string; stopReason: string; errorMessage: string } },
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "overloaded_error",
			},
		});

		expect(fakeThis.chatContainer.removeChild).not.toHaveBeenCalled();
		expect(fakeThis.showReconnectingLine).not.toHaveBeenCalled();
	});

	test("shows the reconnect line for request timeouts and the retry indicator otherwise", async () => {
		initTheme("dark");
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: {
				isInitialized: boolean;
				footer: { invalidate: () => void };
				defaultEditor: { onEscape?: () => void };
				session: { abortRetry: () => void };
				clearStatusIndicator: (kind?: string) => void;
				clearReconnectingLine: () => void;
				showReconnectingLine: (attempt: number, maxAttempts: number) => void;
				showStatusIndicator: (indicator: unknown) => void;
				ui: TUI;
			},
			event: {
				type: "auto_retry_start";
				attempt: number;
				maxAttempts: number;
				delayMs: number;
				errorMessage: string;
			},
		) => Promise<void>;

		const timeoutHost = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			defaultEditor: { onEscape: vi.fn() },
			session: { abortRetry: vi.fn() },
			clearStatusIndicator: vi.fn(),
			clearReconnectingLine: vi.fn(),
			showReconnectingLine: vi.fn(),
			showStatusIndicator: vi.fn(),
			ui,
		};
		await handleEvent.call(timeoutHost, {
			type: "auto_retry_start",
			attempt: 2,
			maxAttempts: 5,
			delayMs: 2000,
			errorMessage: "Request timed out.",
		});
		expect(timeoutHost.showReconnectingLine).toHaveBeenCalledWith(2, 5);
		expect(timeoutHost.showStatusIndicator).not.toHaveBeenCalled();

		const upstreamHost = {
			...timeoutHost,
			clearReconnectingLine: vi.fn(),
			showReconnectingLine: vi.fn(),
			showStatusIndicator: vi.fn(),
		};
		await handleEvent.call(upstreamHost, {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 5,
			delayMs: 2000,
			errorMessage: "upstream_error: connection reset",
		});
		expect(upstreamHost.showReconnectingLine).toHaveBeenCalledWith(1, 5);
		expect(upstreamHost.showStatusIndicator).not.toHaveBeenCalled();

		const retryHost = {
			...timeoutHost,
			clearReconnectingLine: vi.fn(),
			showReconnectingLine: vi.fn(),
			showStatusIndicator: vi.fn(),
		};
		await handleEvent.call(retryHost, {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 2000,
			errorMessage: "overloaded_error",
		});
		expect(retryHost.showReconnectingLine).not.toHaveBeenCalled();
		expect(retryHost.showStatusIndicator).toHaveBeenCalledTimes(1);
		expect(retryHost.showStatusIndicator.mock.calls[0]?.[0]).toBeInstanceOf(RetryStatusIndicator);
	});
});
