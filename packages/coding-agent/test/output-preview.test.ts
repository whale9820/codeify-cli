import { setKeybindings } from "codeify-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { BackgroundTaskMessageComponent } from "../src/modes/interactive/components/background-task-message.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("extension and background output previews", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	for (const kind of ["custom", "background"] as const) {
		it(`caps wrapped ${kind} output and keeps the full content expandable`, () => {
			const message = {
				role: "custom" as const,
				customType: "output",
				content: `Task finished\n${"long output ".repeat(500)}`,
				display: true,
				timestamp: Date.now(),
			};
			const component =
				kind === "custom" ? new CustomMessageComponent(message) : new BackgroundTaskMessageComponent(message);
			const collapsed = component.render(80).map(stripAnsi);
			expect(collapsed.length).toBeLessThanOrEqual(21);
			expect(collapsed.join("\n")).toContain("ctrl+o to expand");
			component.setExpanded(true);
			expect(component.render(80).length).toBeGreaterThan(50);
			component.setExpanded(false);
			expect(component.render(80).map(stripAnsi)).toEqual(collapsed);
		});
	}

	it("uses the configured expansion key for background notifications", () => {
		setKeybindings(new KeybindingsManager({ "app.tools.expand": "ctrl+y" }));
		try {
			const component = new BackgroundTaskMessageComponent({
				role: "custom",
				customType: "background_task",
				content: `Finished\n${Array.from({ length: 139 }, (_, index) => `line-${index}`).join("\n")}`,
				display: true,
				timestamp: Date.now(),
				details: { id: "bg1", status: "completed", startedAt: 0, endedAt: 1000 },
			});
			const collapsed = stripAnsi(component.render(80).join("\n"));
			expect(collapsed).toContain("Background(bg1)");
			expect(collapsed).toContain("ctrl+y to expand");
			expect(collapsed).not.toContain("line-0");
			component.setExpanded(true);
			expect(stripAnsi(component.render(80).join("\n"))).toContain("line-0");
		} finally {
			setKeybindings(new KeybindingsManager());
		}
	});
});
