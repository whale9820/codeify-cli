import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { capOutput, capOutputWithNotice, formatSpillNotice, writeSpillFile } from "../src/core/tools/spill.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../src/core/tools/truncate.ts";

function makeLines(count: number, filler = "x".repeat(40)): string {
	return Array.from({ length: count }, (_, index) => `line ${index + 1} ${filler}`).join("\n");
}

describe("tool output capping", () => {
	it("leaves small output untouched and writes no temp file", () => {
		const result = capOutputWithNotice("short\noutput");

		expect(result.text).toBe("short\noutput");
		expect(result.truncation.truncated).toBe(false);
		expect(result.fullOutputPath).toBeUndefined();
	});

	it("caps output by line count and spills the full text", () => {
		const content = makeLines(DEFAULT_MAX_LINES + 500, "y");
		const result = capOutputWithNotice(content, { tempFilePrefix: "test-lines" });

		expect(result.truncation.truncated).toBe(true);
		expect(result.truncation.truncatedBy).toBe("lines");
		expect(result.truncation.outputLines).toBe(DEFAULT_MAX_LINES);
		expect(result.fullOutputPath).toBeDefined();

		const spilled = readFileSync(result.fullOutputPath as string, "utf-8");
		expect(spilled).toBe(content);
		expect(spilled).toContain(`line ${DEFAULT_MAX_LINES + 500} `);
	});

	it("caps output by byte size when the byte limit is hit first", () => {
		const content = makeLines(5000);
		const result = capOutputWithNotice(content, { tempFilePrefix: "test-bytes" });

		expect(result.truncation.truncatedBy).toBe("bytes");
		expect(Buffer.byteLength(result.text, "utf-8")).toBeLessThan(DEFAULT_MAX_BYTES + 500);
		expect(readFileSync(result.fullOutputPath as string, "utf-8")).toBe(content);
	});

	it("keeps the head of the output and omits the tail the model must read from disk", () => {
		const content = makeLines(5000);
		const result = capOutputWithNotice(content, { tempFilePrefix: "test-head" });

		expect(result.text).toContain("line 1 ");
		expect(result.text).not.toContain("line 5000 ");
		expect(readFileSync(result.fullOutputPath as string, "utf-8")).toContain("line 5000 ");
	});

	it("appends a notice naming the spill path and the omitted range", () => {
		const content = makeLines(5000);
		const result = capOutputWithNotice(content, { tempFilePrefix: "test-notice" });
		const notice = result.text.split("\n").at(-1) ?? "";

		expect(notice).toContain("of 5000");
		expect(notice).toContain(result.fullOutputPath as string);
		expect(notice.startsWith("[")).toBe(true);
		expect(notice.endsWith("]")).toBe(true);
	});

	it("does not append a notice when capOutput is used directly", () => {
		const content = makeLines(5000);
		const result = capOutput(content, { tempFilePrefix: "test-raw" });

		expect(result.truncation.truncated).toBe(true);
		expect(result.text).not.toContain("Full output:");
	});

	it("reports a fallback notice when the spill file cannot be written", () => {
		const content = makeLines(5000);
		const truncation = capOutput(content, { tempFilePrefix: "test-fallback" }).truncation;

		expect(formatSpillNotice(truncation, undefined)).toContain("could not be written");
	});

	it("returns undefined rather than throwing when the spill directory is invalid", () => {
		expect(writeSpillFile("content", "nested/invalid/prefix")).toBeUndefined();
	});

	it("handles a single line that exceeds the byte limit", () => {
		const content = "z".repeat(DEFAULT_MAX_BYTES * 2);
		const result = capOutputWithNotice(content, { tempFilePrefix: "test-longline" });

		expect(result.truncation.truncated).toBe(true);
		expect(result.truncation.firstLineExceedsLimit).toBe(true);
		expect(result.text).toContain("Output withheld");
		expect(readFileSync(result.fullOutputPath as string, "utf-8")).toBe(content);
	});
});
