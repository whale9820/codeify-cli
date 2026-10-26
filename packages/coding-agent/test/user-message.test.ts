import { visibleWidth } from "codeify-tui";
import { describe, expect, test } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

describe("UserMessageComponent", () => {
	test("renders a full-width background rectangle with shell navigation markers", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines).toHaveLength(1);
		expect(lines[0].startsWith(OSC133_ZONE_START + OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		expect(lines[0]).toContain("hello");
		expect(lines[0]).toContain("\x1b[48");
		expect(visibleWidth(lines[0])).toBe(20);

		const multiline = new UserMessageComponent("one\ntwo").render(20);
		expect(multiline).toHaveLength(2);
		expect(multiline[0]).toContain(OSC133_ZONE_START);
		expect(multiline[0]).not.toContain(OSC133_ZONE_END);
		expect(multiline[1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test.each(["dark", "light"])("shades every wrapped and blank row in the %s theme", (themeName) => {
		initTheme(themeName);

		const component = new UserMessageComponent("**hello** world with a longer message\n\nnext paragraph");
		const lines = component.render(20);
		const background = theme.bg("userMessageBg", " ").split(" ")[0];

		expect(lines.length).toBeGreaterThan(3);
		for (const line of lines) {
			expect(line).toContain(background);
			expect(visibleWidth(line)).toBe(20);
		}
		expect(stripAnsi(lines[0]).trimEnd()).toBe(" ❯ hello world with");
		expect(lines.some((line) => stripAnsi(line).trim() === "")).toBe(true);

		component.setOutputPad(3);
		const paddedLines = component.render(30);
		expect(stripAnsi(paddedLines[0]).startsWith("   ❯ ")).toBe(true);
		for (const line of paddedLines) {
			expect(line).toContain(background);
			expect(visibleWidth(line)).toBe(30);
		}
	});
});
