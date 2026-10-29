import { setKeybindings, type TUI } from "codeify-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { formatTaskLine } from "../src/core/background-tasks.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SelectorComponent } from "../src/modes/interactive/components/selector.ts";
import { TaskFollowComponent } from "../src/modes/interactive/components/task-follow.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

describe("background task display", () => {
	it("keeps multiline descriptions concise", () => {
		const line = formatTaskLine({
			id: "bg1",
			kind: "agent",
			status: "running",
			startedAt: Date.now(),
			description: `first\n${"x".repeat(500)}`,
		});
		expect(line).not.toContain("\n");
		expect(line.length).toBeLessThan(120);
		expect(line).toContain("…");
	});

	it("wraps selector navigation in both directions", () => {
		const select = vi.fn();
		const selector = new SelectorComponent("Tasks", ["first", "last"], select, () => {});
		selector.handleInput("\x1b[A");
		selector.handleInput("\r");
		expect(select).toHaveBeenLastCalledWith("last");
		selector.handleInput("\x1b[B");
		selector.handleInput("\r");
		expect(select).toHaveBeenLastCalledWith("first");
	});

	it("fits the live tail within the terminal", () => {
		const tui = { terminal: { columns: 40, rows: 20 }, requestRender: vi.fn() } as unknown as TUI;
		const view = new TaskFollowComponent({
			tui,
			taskId: "bg1",
			getTask: () => ({ id: "bg1", kind: "agent", status: "running", startedAt: Date.now(), description: "task" }),
			getOutput: () => ({ text: Array(100).fill("x".repeat(100)).join("\n"), droppedChars: 0 }),
			onStop: () => {},
			onClose: () => {},
		});
		try {
			const lines = view.render(40).map(stripAnsi);
			expect(lines.length).toBeLessThanOrEqual(20);
			expect(lines.join("\n")).toContain("earlier lines");
		} finally {
			view.dispose();
		}
	});
});
