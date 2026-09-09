import { Text } from "codeify-tui";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

export class ErrorDetailsComponent extends Text {
	private readonly details: string;
	private expanded = false;

	constructor(details: string, padding = 1) {
		super("", padding, 0);
		this.details = stripAnsi(details);
		this.refresh();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.refresh();
	}

	private refresh(): void {
		const title = theme.fg("muted", `${this.expanded ? "[-]" : "[+]"} Response interrupted`);
		this.setText(`${title} ${keyHint("app.tools.expand", "details")}${this.expanded ? `\n${this.details}` : ""}`);
	}
}
