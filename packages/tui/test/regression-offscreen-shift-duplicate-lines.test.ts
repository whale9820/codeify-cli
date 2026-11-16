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

function assertNoDuplicates(terminal: VirtualTerminal): void {
	const buffer = terminal.getScrollBuffer().map((line) => line.trimEnd());
	const seen = new Set<string>();
	for (const line of buffer) {
		if (!line.startsWith("Line ")) continue;
		assert.ok(!seen.has(line), `duplicated in scrollback: ${line}\n${buffer.join("\n")}`);
		seen.add(line);
	}
}

async function setup(): Promise<{ terminal: VirtualTerminal; tui: TUI; header: Lines; body: Lines }> {
	const terminal = new VirtualTerminal(60, 8);
	const tui = new TUI(terminal, true);
	const header = new Lines(["Header a", "Header b"]);
	const body = new Lines(Array.from({ length: 30 }, (_, index) => `Line ${index}`));
	const editor = new Lines(["─".repeat(60), `> ${CURSOR_MARKER}`]);
	tui.addChild(header);
	tui.addChild(body);
	tui.addChild(editor);
	tui.start();
	await terminal.waitForRender();
	return { terminal, tui, header, body };
}

describe("scrollback after offscreen line count changes", () => {
	it("does not duplicate lines when lines are inserted above the viewport", async () => {
		const { terminal, tui, header, body } = await setup();
		try {
			header.lines = ["Header a", "Header a2", "Header a3", "Header b"];
			body.lines.push("Line 30");
			tui.requestRender();
			await terminal.waitForRender();
			assertNoDuplicates(terminal);
			assert.ok(terminal.getViewport().some((line) => line.startsWith("Line 30")));
			assert.ok(terminal.getViewport().some((line) => line.startsWith(">")));
		} finally {
			tui.stop();
		}
	});

	it("does not duplicate lines when lines are removed above the viewport", async () => {
		const { terminal, tui, header, body } = await setup();
		try {
			header.lines = [];
			body.lines[body.lines.length - 1] = "Line 29 updated";
			tui.requestRender();
			await terminal.waitForRender();
			assertNoDuplicates(terminal);
			assert.ok(terminal.getViewport().some((line) => line.startsWith("Line 29 updated")));
			assert.ok(terminal.getViewport().some((line) => line.startsWith(">")));
		} finally {
			tui.stop();
		}
	});
});
