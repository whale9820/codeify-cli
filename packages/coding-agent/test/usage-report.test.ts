import { describe, expect, it } from "vitest";
import { formatUsageReport } from "../src/modes/interactive/usage-report.ts";

describe("formatUsageReport", () => {
	it("prints a single compact token line", () => {
		expect(
			formatUsageReport({ tokens: { input: 3_900, output: 97_000, cacheRead: 19_900_000, cacheWrite: 239_600 } }),
		).toBe("3.9k input, 97.0k output, 19.9m cache read, 239.6k cache write");
	});

	it("prints small and zero counts as plain numbers", () => {
		expect(formatUsageReport({ tokens: { input: 842, output: 0, cacheRead: 0, cacheWrite: 999 } })).toBe(
			"842 input, 0 output, 0 cache read, 999 cache write",
		);
	});

	it("rounds into the next unit at the boundary", () => {
		expect(formatUsageReport({ tokens: { input: 1_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 } })).toBe(
			"1.0k input, 1.0m output, 0 cache read, 0 cache write",
		);
	});
});
