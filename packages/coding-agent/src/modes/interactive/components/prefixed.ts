import { type Component, visibleWidth } from "codeify-tui";
import { stripAnsi } from "../../../utils/ansi.ts";

export class PrefixedComponent implements Component {
	private child: Component;
	private firstPrefix: string;
	private restPrefix: string;
	private skipLeadingBlank: boolean;
	private prefixWidth: number;
	private cache?: { width: number; childLines: string[]; lines: string[] };

	constructor(child: Component, firstPrefix: string, restPrefix: string, skipLeadingBlank = false) {
		this.child = child;
		this.firstPrefix = firstPrefix;
		this.restPrefix = restPrefix;
		this.skipLeadingBlank = skipLeadingBlank;
		this.prefixWidth = Math.max(visibleWidth(firstPrefix), visibleWidth(restPrefix));
	}

	invalidate(): void {
		this.cache = undefined;
		this.child.invalidate?.();
	}

	render(width: number): string[] {
		const lines = this.child.render(Math.max(1, width - this.prefixWidth));
		const cache = this.cache;
		if (
			cache &&
			cache.width === width &&
			cache.childLines.length === lines.length &&
			cache.childLines.every((line, index) => line === lines[index])
		) {
			return cache.lines;
		}
		let start = 0;
		if (this.skipLeadingBlank) {
			while (start < lines.length && stripAnsi(lines[start]).trim() === "") start++;
		}
		const prefixed = lines
			.slice(start)
			.map((line, index) => (index === 0 ? this.firstPrefix : this.restPrefix) + line);
		this.cache = { width, childLines: lines.slice(), lines: prefixed };
		return prefixed;
	}
}
