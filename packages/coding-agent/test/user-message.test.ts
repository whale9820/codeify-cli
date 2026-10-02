import { describe, expect, test } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const BG_RESET = "\x1b[49m";

describe("UserMessageComponent", () => {
	test("renders a single-row bar and keeps closing OSC markers off line end", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines).toHaveLength(1);
		expect(lines[0].startsWith(OSC133_ZONE_START + OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		expect(lines[0]).toContain("hello");
		expect(lines[0].endsWith(BG_RESET)).toBe(true);

		const multiline = new UserMessageComponent("one\ntwo").render(20);
		expect(multiline).toHaveLength(2);
		expect(multiline[0]).toContain(OSC133_ZONE_START);
		expect(multiline[0]).not.toContain(OSC133_ZONE_END);
		expect(multiline[1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});
});
