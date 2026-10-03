import { Container, Markdown, type MarkdownTheme, Text } from "codeify-tui";
import type { ParsedSkillBlock } from "../../../core/agent-session.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";
import { PrefixedComponent } from "./prefixed.ts";

export class SkillInvocationMessageComponent extends Container {
	private expanded = false;
	private skillBlock: ParsedSkillBlock;
	private markdownTheme: MarkdownTheme;

	constructor(skillBlock: ParsedSkillBlock, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		this.skillBlock = skillBlock;
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

		this.addChild(
			new Text(
				`${theme.fg("success", "●")} ${theme.bold("Skill")} ${theme.fg("muted", this.skillBlock.name)}`,
				0,
				0,
			),
		);

		const body = this.expanded
			? new Markdown(this.skillBlock.content, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("toolOutput", text),
				})
			: new Text(theme.fg("dim", `${keyText("app.tools.expand")} to expand`), 0, 0);
		this.addChild(new PrefixedComponent(body, `  ${theme.fg("dim", "⎿")}  `, "     ", true));
	}
}
