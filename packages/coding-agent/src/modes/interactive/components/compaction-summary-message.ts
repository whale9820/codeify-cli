import { Container, Markdown, type MarkdownTheme, Text } from "codeify-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";
import { PrefixedComponent } from "./prefixed.ts";

export class CompactionSummaryMessageComponent extends Container {
	private expanded = false;
	private message: CompactionSummaryMessage;
	private markdownTheme: MarkdownTheme;

	constructor(message: CompactionSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
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

		const tokenStr = this.message.tokensBefore.toLocaleString();
		const title = `${theme.fg("success", "●")} ${theme.bold("Compacted conversation")}`;
		this.addChild(new Text(`${title} ${theme.fg("dim", `from ${tokenStr} tokens`)}`, 0, 0));

		const body = this.expanded
			? new Markdown(this.message.summary, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("toolOutput", text),
				})
			: new Text(theme.fg("dim", `${keyText("app.tools.expand")} to expand`), 0, 0);
		this.addChild(new PrefixedComponent(body, `  ${theme.fg("dim", "⎿")}  `, "     ", true));
	}
}
