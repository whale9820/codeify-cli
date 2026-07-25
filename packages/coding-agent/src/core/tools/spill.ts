import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

export interface SpillOptions {
	maxLines?: number;
	maxBytes?: number;
	tempFilePrefix?: string;
}

export interface SpillResult {
	text: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
}

function spillFilePath(prefix: string): string {
	return join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}.log`);
}

/**
 * Write the full text to a temp file so the model can read the parts that were
 * cut. Returns undefined when the spill file cannot be written, so callers fall
 * back to a plain truncation notice rather than failing the tool call.
 */
export function writeSpillFile(content: string, prefix: string): string | undefined {
	try {
		const path = spillFilePath(prefix);
		writeFileSync(path, content, "utf-8");
		return path;
	} catch {
		return undefined;
	}
}

/**
 * Cap tool output to a reasonable size, spilling the full text to a temp file
 * and pointing the model at it.
 *
 * Keeps the head of the output because non-streaming tools put their most
 * relevant content first, unlike bash where the tail carries the outcome.
 */
export function capOutput(content: string, options: SpillOptions = {}): SpillResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const truncation = truncateHead(content, { maxLines, maxBytes });

	if (!truncation.truncated) {
		return { text: content, truncation };
	}

	const fullOutputPath = writeSpillFile(content, options.tempFilePrefix ?? "codeify-output");
	return { text: truncation.content, truncation, fullOutputPath };
}

/**
 * Build the notice appended to capped output. Describes what was kept, what the
 * full size was, and where to read the rest.
 */
export function formatSpillNotice(truncation: TruncationResult, fullOutputPath: string | undefined): string {
	const shown =
		truncation.outputLines > 0
			? `Showing lines 1-${truncation.outputLines} of ${truncation.totalLines}`
			: `Output withheld (first line is ${formatSize(truncation.totalBytes)})`;
	const limit =
		truncation.truncatedBy === "bytes"
			? ` (${formatSize(truncation.maxBytes)} limit, ${formatSize(truncation.totalBytes)} total)`
			: ` (${truncation.maxLines} line limit)`;
	const location = fullOutputPath
		? `. Full output: ${fullOutputPath}`
		: ". Full output could not be written to a temp file";
	return `${shown}${limit}${location}`;
}

/**
 * Cap output and append the spill notice in one step, for tools that do not
 * build their own multi-notice suffix.
 */
export function capOutputWithNotice(content: string, options: SpillOptions = {}): SpillResult {
	const capped = capOutput(content, options);
	if (!capped.truncation.truncated) {
		return capped;
	}
	const notice = formatSpillNotice(capped.truncation, capped.fullOutputPath);
	const body = capped.text ? `${capped.text}\n\n` : "";
	return { ...capped, text: `${body}[${notice}]` };
}

export { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES };
