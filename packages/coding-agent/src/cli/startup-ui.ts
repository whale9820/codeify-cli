import { ProcessTerminal, setKeybindings, TUI } from "@earendil-works/pi-tui";
import { existsSync } from "fs";
import { ENV_AGENT_DIR, getSettingsPath } from "../config.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import {
	FirstTimeSetupComponent,
	type FirstTimeSetupResult,
} from "../modes/interactive/components/first-time-setup.ts";
import { InputDialogComponent } from "../modes/interactive/components/input-dialog.ts";
import { SelectorComponent } from "../modes/interactive/components/selector.ts";
import {
	detectTerminalBackgroundFromEnv,
	detectTerminalThemeForAuto,
	initTheme,
	parseAutoThemeSetting,
	resolveThemeSetting,
	setRegisteredThemes,
	setTheme,
} from "../modes/interactive/theme/theme.ts";

export async function createStartupTui(settingsManager: SettingsManager): Promise<TUI> {
	setRegisteredThemes([]);
	const terminalTheme = detectTerminalBackgroundFromEnv().theme;
	initTheme(resolveThemeSetting(settingsManager.getThemeSetting(), terminalTheme) ?? terminalTheme);
	setKeybindings(KeybindingsManager.create());
	const ui = new TUI(new ProcessTerminal(), settingsManager.getShowHardwareCursor());
	ui.setClearOnShrink(settingsManager.getClearOnShrink());
	return ui;
}

export function startStartupTui(ui: TUI, settingsManager: SettingsManager): void {
	ui.start();
	void applyDetectedStartupTheme(ui, settingsManager);
}

async function applyDetectedStartupTheme(ui: TUI, settingsManager: SettingsManager): Promise<void> {
	const themeSetting = settingsManager.getThemeSetting();
	if (themeSetting && !parseAutoThemeSetting(themeSetting)) return;

	const terminalTheme = await detectTerminalThemeForAuto({ ui, timeoutMs: 100 });
	setTheme(resolveThemeSetting(themeSetting, terminalTheme) ?? terminalTheme);
	ui.invalidate();
	ui.requestRender();
}

async function clearStartupTui(ui: TUI): Promise<void> {
	ui.clear();
	ui.requestRender();
	await new Promise((resolve) => setTimeout(resolve, 25));
}

/**
 * First-time setup runs when all of these hold:
 * - this is the first Codeify launch
 * - the default agent directory is used (no custom agent dir override)
 * - setup was not completed before (settings.json does not exist)
 */
export function shouldRunFirstTimeSetup(settingsPath: string = getSettingsPath()): boolean {
	if (process.env[ENV_AGENT_DIR]) {
		return false;
	}
	return !existsSync(settingsPath);
}

export async function showStartupSelector<T>(
	settingsManager: SettingsManager,
	title: string,
	options: Array<{ label: string; value: T }>,
): Promise<T | undefined> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: T | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		const selector = new SelectorComponent(
			title,
			options.map((option) => option.label),
			(option) => void finish(options.find((entry) => entry.label === option)?.value),
			() => void finish(undefined),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		startStartupTui(ui, settingsManager);
	});
}

/** Show the first-time setup dialog and persist the result */
export async function showFirstTimeSetup(settingsManager: SettingsManager): Promise<void> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: FirstTimeSetupResult | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			if (result) {
				settingsManager.setTheme(result.theme);
				await settingsManager.flush();
			}
			await clearStartupTui(ui);
			ui.stop();
			resolve();
		};

		const showSetup = async () => {
			ui.start();
			const detectedTheme = await detectTerminalThemeForAuto({ ui, timeoutMs: 100 });
			setTheme(detectedTheme);
			const component = new FirstTimeSetupComponent({
				detectedTheme,
				onThemePreview: (themeName) => {
					setTheme(themeName);
					ui.requestRender();
				},
				onSubmit: (result) => void finish(result),
				onCancel: () => void finish(undefined),
			});
			ui.addChild(component);
			ui.setFocus(component);
			ui.requestRender();
		};

		void showSetup();
	});
}

export async function showStartupInput(
	settingsManager: SettingsManager,
	title: string,
	placeholder?: string,
	options?: { secret?: boolean },
): Promise<string | undefined> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			input.dispose();
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		const input = new InputDialogComponent(
			title,
			placeholder,
			(value) => void finish(value),
			() => void finish(undefined),
			{
				tui: ui,
				secret: options?.secret,
			},
		);
		ui.addChild(input);
		ui.setFocus(input);
		startStartupTui(ui, settingsManager);
	});
}
