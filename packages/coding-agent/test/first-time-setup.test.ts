import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { shouldRunFirstTimeSetup } from "../src/cli/startup-ui.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { FirstTimeSetupComponent } from "../src/modes/interactive/components/first-time-setup.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

describe("FirstTimeSetupComponent", () => {
	it("renders the Codeify CLI name without the block logo", () => {
		const component = new FirstTimeSetupComponent({
			detectedTheme: "dark",
			onThemePreview: () => {},
			onSubmit: () => {},
			onCancel: () => {},
		});
		const rendered = component.render(80).join("\n");

		expect(rendered).toContain("Welcome to codeify cli");
		expect(rendered).not.toContain("██████");
	});
});

describe("shouldRunFirstTimeSetup", () => {
	const originalAgentDir = process.env[ENV_AGENT_DIR];
	let tempDir: string;
	let settingsPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-first-time-setup-"));
		settingsPath = join(tempDir, "settings.json");
		delete process.env[ENV_AGENT_DIR];
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
	});

	it("returns true with the default agent dir and no settings.json", () => {
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(true);
	});

	it("returns false when a custom agent dir is set", () => {
		process.env[ENV_AGENT_DIR] = tempDir;

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});

	it("returns false when settings.json already exists", () => {
		writeFileSync(settingsPath, "{}", "utf-8");

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});
});
