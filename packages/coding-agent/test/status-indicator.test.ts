import type { TUI } from "codeify-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	IdleStatus,
	ReconnectStatusIndicator,
	RetryStatusIndicator,
} from "../src/modes/interactive/components/status-indicator.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("status indicators", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps idle status at the same height as status indicators", () => {
		const idleStatus = new IdleStatus();

		const lines = idleStatus.render(20);
		expect(lines).toHaveLength(2);
		expect(lines).toEqual([" ".repeat(20), " ".repeat(20)]);
	});

	it("disposes retry countdown updates", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = { requestRender } as unknown as TUI;
		const indicator = new RetryStatusIndicator(tui, 1, 3, 1000);
		const callsBeforeDispose = requestRender.mock.calls.length;

		indicator.dispose();
		vi.advanceTimersByTime(2000);

		expect(requestRender).toHaveBeenCalledTimes(callsBeforeDispose);
	});

	it("renders reconnect status like the retry indicator", () => {
		initTheme("dark");
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const reconnect = new ReconnectStatusIndicator(tui, 2, 5);
		const retry = new RetryStatusIndicator(tui, 2, 5, 1000);

		try {
			const reconnectText = stripAnsi(reconnect.render(80).join("\n"));
			expect(reconnectText).toContain("Reconnecting (2/5)...");
			expect(reconnect.kind).toBe("retry");
			expect(reconnect.render(80)).toHaveLength(retry.render(80).length);
		} finally {
			reconnect.dispose();
			retry.dispose();
		}
	});
});
