import { Text } from "codeify-tui";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

export const OUTPUT_PREVIEW_LINES = 20;

export function previewOutput(lines: string[], expanded: boolean, width: number): string[] {
	if (expanded || lines.length <= OUTPUT_PREVIEW_LINES) return lines;
	const hidden = lines.length - OUTPUT_PREVIEW_LINES;
	const hint = new Text(
		`  ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ` (${hidden} more lines)`)}`,
		0,
		0,
	);
	return [...lines.slice(0, OUTPUT_PREVIEW_LINES), ...hint.render(width)];
}
