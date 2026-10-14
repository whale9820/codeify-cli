import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, CURSOR_MARKER, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class Lines implements Component {
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return [...this.lines];
	}

	invalidate(): void {}
}

describe("scrollback after status cleanup", () => {
	it("keeps each response line once when a working row disappears and returns", async () => {
		const terminal = new VirtualTerminal(100, 8);
		const tui = new TUI(terminal, true);
		const response = new Lines(Array.from({ length: 20 }, (_, index) => `Response line ${index}`));
		const working = new Lines(["Working"]);
		const editor = new Lines(["─".repeat(100), `> ${CURSOR_MARKER}`, "─".repeat(100), "model"]);
		tui.addChild(response);
		tui.addChild(working);
		tui.addChild(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			const redraws = tui.fullRedraws;
			for (const lines of [[], ["Working"], []]) {
				working.lines = lines;
				tui.requestRender();
				await terminal.waitForRender();
				const buffer = terminal.getScrollBuffer();
				for (const line of response.lines) {
					assert.equal(buffer.filter((actual) => actual === line).length, 1, line);
				}
				assert.equal(tui.fullRedraws, redraws);
				assert.ok(terminal.getViewport().includes("model"));
			}
			response.lines.push("Response line 20");
			tui.requestRender();
			await terminal.waitForRender();
			assert.deepEqual(
				terminal.getScrollBuffer().map((line) => line.trimEnd()),
				[...response.lines, "─".repeat(100), ">", "─".repeat(100), "model"],
			);
		} finally {
			tui.stop();
		}
	});
});
