import { Container, Markdown, type MarkdownTheme, Text } from "codeify-tui";
import type { BranchSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";
import { PrefixedComponent } from "./prefixed.ts";

export class BranchSummaryMessageComponent extends Container {
	private expanded = false;
	private message: BranchSummaryMessage;
	private markdownTheme: MarkdownTheme;

	constructor(message: BranchSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();

		this.addChild(new Text(`${theme.fg("success", "●")} ${theme.bold("Branch summary")}`, 0, 0));

		const body = this.expanded
			? new Markdown(this.message.summary, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("toolOutput", text),
				})
			: new Text(theme.fg("dim", `${keyText("app.tools.expand")} to expand`), 0, 0);
		this.addChild(new PrefixedComponent(body, `  ${theme.fg("dim", "⎿")}  `, "     ", true));
	}
}
