import { type Component, visibleWidth, wrapTextWithAnsi } from "codeify-tui";
import * as Diff from "diff";
import { theme } from "../theme/theme.ts";

/**
 * Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

/**
 * Replace tabs with spaces for consistent rendering.
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * Compute word-level diff and render with inverse on changed parts.
 * Uses diffWords which groups whitespace with adjacent words for cleaner highlighting.
 * Strips leading whitespace from inverse to avoid highlighting indentation.
 */
function renderIntraLineDiff(oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);

	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			// Strip leading whitespace from the first removed part
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) {
				removedLine += theme.inverse(value);
			}
		} else if (part.added) {
			let value = part.value;
			// Strip leading whitespace from the first added part
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) {
				addedLine += theme.inverse(value);
			}
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}

	return { removedLine, addedLine };
}

export interface RenderDiffOptions {
	/** File path (unused, kept for API compatibility) */
	filePath?: string;
}

export type DiffLineKind = "added" | "removed" | "context";

export interface DiffLine {
	text: string;
	kind: DiffLineKind;
}

function formatDiffRow(lineNum: string, sign: string, content: string): string {
	return `${lineNum} ${sign} ${content}`;
}

export function renderDiffLines(diffText: string, _options: RenderDiffOptions = {}): DiffLine[] {
	const lines = diffText.split("\n");
	const result: DiffLine[] = [];

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const parsed = parseDiffLine(line);

		if (!parsed) {
			result.push({ text: theme.fg("toolDiffContext", line), kind: "context" });
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			const removedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "-") break;
				removedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			const addedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0];
				const added = addedLines[0];

				const { removedLine, addedLine } = renderIntraLineDiff(
					replaceTabs(removed.content),
					replaceTabs(added.content),
				);

				result.push({
					text: theme.fg("toolDiffRemoved", formatDiffRow(removed.lineNum, "-", removedLine)),
					kind: "removed",
				});
				result.push({
					text: theme.fg("toolDiffAdded", formatDiffRow(added.lineNum, "+", addedLine)),
					kind: "added",
				});
			} else {
				for (const removed of removedLines) {
					result.push({
						text: theme.fg("toolDiffRemoved", formatDiffRow(removed.lineNum, "-", replaceTabs(removed.content))),
						kind: "removed",
					});
				}
				for (const added of addedLines) {
					result.push({
						text: theme.fg("toolDiffAdded", formatDiffRow(added.lineNum, "+", replaceTabs(added.content))),
						kind: "added",
					});
				}
			}
		} else if (parsed.prefix === "+") {
			result.push({
				text: theme.fg("toolDiffAdded", formatDiffRow(parsed.lineNum, "+", replaceTabs(parsed.content))),
				kind: "added",
			});
			i++;
		} else {
			result.push({
				text: theme.fg("toolDiffContext", formatDiffRow(parsed.lineNum, " ", replaceTabs(parsed.content))),
				kind: "context",
			});
			i++;
		}
	}

	return result;
}

export function renderDiff(diffText: string, options: RenderDiffOptions = {}): string {
	return renderDiffLines(diffText, options)
		.map((line) => line.text)
		.join("\n");
}

export function summarizeDiff(diffText: string): { additions: number; removals: number } {
	let additions = 0;
	let removals = 0;
	for (const line of diffText.split("\n")) {
		const parsed = parseDiffLine(line);
		if (parsed?.prefix === "+") additions++;
		else if (parsed?.prefix === "-") removals++;
	}
	return { additions, removals };
}

export class DiffComponent implements Component {
	private lines: DiffLine[];

	constructor(diffText: string) {
		this.lines = renderDiffLines(diffText);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const out: string[] = [];
		for (const line of this.lines) {
			const bg = line.kind === "added" ? "toolSuccessBg" : line.kind === "removed" ? "toolErrorBg" : undefined;
			for (const row of wrapTextWithAnsi(line.text, Math.max(1, width))) {
				if (!bg) {
					out.push(row);
					continue;
				}
				const padding = " ".repeat(Math.max(0, width - visibleWidth(row)));
				out.push(theme.bg(bg, row + padding));
			}
		}
		return out;
	}
}
