import { describe, expect, it } from "vitest";
import { formatUsageReport } from "../src/modes/interactive/usage-report.ts";

describe("formatUsageReport", () => {
	it("prints a single compact token line", () => {
		expect(
			formatUsageReport({
				tokens: { input: 3_900, output: 97_000, cacheRead: 19_900_000, cacheWrite: 239_600 },
				contextUsage: { tokens: 371_200, contextWindow: 1_000_000 },
			}),
		).toBe("371.2k/1m context, 98.8% cached, 3.9k input, 97.0k output, 19.9m cache read, 239.6k cache write");
	});

	it("prints small and zero counts as plain numbers", () => {
		expect(formatUsageReport({ tokens: { input: 842, output: 0, cacheRead: 0, cacheWrite: 999 } })).toBe(
			"?/? context, 0.0% cached, 842 input, 0 output, 0 cache read, 999 cache write",
		);
	});

	it("rounds into the next unit at the boundary", () => {
		expect(formatUsageReport({ tokens: { input: 1_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 } })).toBe(
			"?/? context, 0.0% cached, 1.0k input, 1.0m output, 0 cache read, 0 cache write",
		);
	});

	it("handles zero usage and unknown context after compaction", () => {
		expect(
			formatUsageReport({
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextUsage: { tokens: null, contextWindow: 200_000 },
			}),
		).toBe("?/200k context, 0.0% cached, 0 input, 0 output, 0 cache read, 0 cache write");
	});
});
