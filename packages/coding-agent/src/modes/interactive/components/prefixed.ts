import { type Component, visibleWidth } from "codeify-tui";
import { stripAnsi } from "../../../utils/ansi.ts";

export class PrefixedComponent implements Component {
	private child: Component;
	private firstPrefix: string;
	private restPrefix: string;
	private skipLeadingBlank: boolean;

	constructor(child: Component, firstPrefix: string, restPrefix: string, skipLeadingBlank = false) {
		this.child = child;
		this.firstPrefix = firstPrefix;
		this.restPrefix = restPrefix;
		this.skipLeadingBlank = skipLeadingBlank;
	}

	invalidate(): void {
		this.child.invalidate?.();
	}

	render(width: number): string[] {
		const prefixWidth = Math.max(visibleWidth(this.firstPrefix), visibleWidth(this.restPrefix));
		const lines = this.child.render(Math.max(1, width - prefixWidth));
		let start = 0;
		if (this.skipLeadingBlank) {
			while (start < lines.length && stripAnsi(lines[start]).trim() === "") start++;
		}
		return lines.slice(start).map((line, index) => (index === 0 ? this.firstPrefix : this.restPrefix) + line);
	}
}
