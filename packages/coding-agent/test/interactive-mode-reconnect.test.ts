import type { TUI } from "codeify-tui";
import { describe, expect, test, vi } from "vitest";
import {
	ReconnectStatusIndicator,
	RetryStatusIndicator,
} from "../src/modes/interactive/components/status-indicator.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type MessageEndHost = {
	isInitialized: boolean;
	footer: { invalidate: () => void };
	streamingComponent: { updateContent: () => void } | undefined;
	streamingMessage: unknown;
	pendingTools: Map<string, unknown>;
	chatContainer: { removeChild: (component: unknown) => void };
	session: { retryAttempt: number; willRetryAssistantMessage: () => boolean };
	applyCitationSources: () => void;
	maybeShowCacheMissNotice: () => void;
	ui: { requestRender: () => void };
};

function messageEndHost(willRetry: boolean) {
	const errorComponent = { updateContent: vi.fn() };
	const host = {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		streamingComponent: errorComponent as MessageEndHost["streamingComponent"],
		streamingMessage: undefined as unknown,
		pendingTools: new Map<string, unknown>(),
		chatContainer: { removeChild: vi.fn() },
		session: { retryAttempt: 0, willRetryAssistantMessage: vi.fn(() => willRetry) },
		applyCitationSources: vi.fn(),
		maybeShowCacheMissNotice: vi.fn(),
		ui: { requestRender: vi.fn() },
	};
	return { host, errorComponent };
}

const handleMessageEnd = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
	this: MessageEndHost,
	event: { type: "message_end"; message: { role: string; stopReason: string; errorMessage: string } },
) => Promise<void>;

describe("InteractiveMode reconnect status", () => {
	test("hides a connection error that will be retried", async () => {
		const { host, errorComponent } = messageEndHost(true);

		await handleMessageEnd.call(host, {
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "API Error (522): 522 status code (no body)",
			},
		});

		expect(errorComponent.updateContent).not.toHaveBeenCalled();
		expect(host.chatContainer.removeChild).toHaveBeenCalledWith(errorComponent);
		expect(host.streamingComponent).toBeUndefined();
	});

	test("hides a non-reconnect error that will be retried", async () => {
		const { host, errorComponent } = messageEndHost(true);

		await handleMessageEnd.call(host, {
			type: "message_end",
			message: { role: "assistant", stopReason: "error", errorMessage: "overloaded_error" },
		});

		expect(errorComponent.updateContent).not.toHaveBeenCalled();
		expect(host.chatContainer.removeChild).toHaveBeenCalledWith(errorComponent);
	});

	test("keeps the error in the chat when no retry follows", async () => {
		const { host, errorComponent } = messageEndHost(false);

		await handleMessageEnd.call(host, {
			type: "message_end",
			message: { role: "assistant", stopReason: "error", errorMessage: "overloaded_error" },
		});

		expect(errorComponent.updateContent).toHaveBeenCalled();
		expect(host.chatContainer.removeChild).not.toHaveBeenCalled();
	});

	test("uses the spinner status for reconnects and retries", async () => {
		initTheme("dark");
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: {
				isInitialized: boolean;
				footer: { invalidate: () => void };
				defaultEditor: { onEscape?: () => void };
				session: { abortRetry: () => void };
				showStatusIndicator: (indicator: { dispose: () => void }) => void;
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
		const host = () => ({
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			defaultEditor: { onEscape: vi.fn() },
			session: { abortRetry: vi.fn() },
			showStatusIndicator: vi.fn((indicator: { dispose: () => void }) => indicator.dispose()),
			ui,
		});

		const timeoutHost = host();
		await handleEvent.call(timeoutHost, {
			type: "auto_retry_start",
			attempt: 2,
			maxAttempts: 5,
			delayMs: 2000,
			errorMessage: "Request timed out.",
		});
		expect(timeoutHost.showStatusIndicator.mock.calls[0]?.[0]).toBeInstanceOf(ReconnectStatusIndicator);

		const upstreamHost = host();
		await handleEvent.call(upstreamHost, {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 5,
			delayMs: 2000,
			errorMessage: "upstream_error: connection reset",
		});
		expect(upstreamHost.showStatusIndicator.mock.calls[0]?.[0]).toBeInstanceOf(ReconnectStatusIndicator);

		const eofHost = host();
		await handleEvent.call(eofHost, {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 5,
			delayMs: 2000,
			errorMessage: "unexpected EOF",
		});
		expect(eofHost.showStatusIndicator.mock.calls[0]?.[0]).toBeInstanceOf(ReconnectStatusIndicator);

		const retryHost = host();
		await handleEvent.call(retryHost, {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 2000,
			errorMessage: "overloaded_error",
		});
		expect(retryHost.showStatusIndicator.mock.calls[0]?.[0]).toBeInstanceOf(RetryStatusIndicator);
	});
});
