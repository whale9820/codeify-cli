import chalk from "chalk";
import type { AssistantMessage } from "codeify-ai";
import type { TUI } from "codeify-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import {
	createReconnectStatusLine,
	IdleStatus,
	RetryStatusIndicator,
} from "../src/modes/interactive/components/status-indicator.ts";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
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

	it("renders reconnect status in the thinking font, bold", () => {
		initTheme("dark");
		const previousLevel = chalk.level;
		chalk.level = 3;
		const label = "Reconnecting... (1/5)";
		const reconnect = createReconnectStatusLine(label, 1, getMarkdownTheme());
		const thinking = new AssistantMessageComponent({
			role: "assistant",
			content: [{ type: "thinking", thinking: label }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-4o-mini",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		} satisfies AssistantMessage);

		try {
			const reconnectRendered = reconnect.render(80).join("\n");
			const thinkingRendered = thinking.render(80).join("\n");
			const thinkingStyled = theme.italic(theme.fg("thinkingText", label));
			const reconnectStyled = theme.italic(theme.bold(theme.fg("thinkingText", label)));

			expect(stripAnsi(reconnectRendered)).toContain(label);
			expect(reconnectRendered).toContain(reconnectStyled);
			expect(thinkingRendered).toContain(thinkingStyled);
			expect(reconnectRendered).not.toContain(thinkingStyled);
		} finally {
			chalk.level = previousLevel;
		}
	});
});
