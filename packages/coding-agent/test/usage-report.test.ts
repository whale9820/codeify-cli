import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { formatUsageReport, type UsageReportInput } from "../src/modes/interactive/usage-report.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function input(overrides: Partial<UsageReportInput> = {}): UsageReportInput {
	return {
		tokens: { input: 5_000, output: 3_000, cacheRead: 45_000, cacheWrite: 2_000 },
		cost: 0.1234,
		assistantMessages: 14,
		context: { tokens: 24_600, contextWindow: 200_000, percent: 12.3 },
		autoCompact: true,
		breakdown: [],
		latestCacheHitRate: 90,
		cacheWaste: { missedTokens: 0, missCount: 0, missedCost: 0 },
		modelId: "gpt-test",
		...overrides,
	};
}

describe("formatUsageReport", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("explains context, tokens, cache, and cost in sentences", () => {
		const text = stripAnsi(formatUsageReport(input()));
		expect(text).toContain("12.3% of the 200k token window is in use (24,600 tokens).");
		expect(text).toContain("Auto-compaction is on");
		expect(text).toContain("The model has produced 14 responses, most recently with gpt-test.");
		expect(text).toContain("It read 52,000 tokens of input and wrote 3,000 tokens of output.");
		expect(text).toContain("45,000 tokens of that input (86.5%) was served from the prompt cache");
		expect(text).toContain("2,000 tokens were written to the cache for later reuse.");
		expect(text).toContain("The most recent request had a cache hit rate of 90%.");
		expect(text).toContain("This session has cost $0.123 so far.");
	});

	it("explains an unknown context size after compaction", () => {
		const text = stripAnsi(
			formatUsageReport(input({ context: { tokens: null, contextWindow: 200_000, percent: null } })),
		);
		expect(text).toContain("not known yet");
	});

	it("handles subscription sessions without cost and no cache usage", () => {
		const text = stripAnsi(
			formatUsageReport(
				input({
					cost: 0,
					autoCompact: false,
					tokens: { input: 1_000, output: 10, cacheRead: 0, cacheWrite: 0 },
				}),
			),
		);
		expect(text).toContain("No per-token cost has been recorded");
		expect(text).toContain("Auto-compaction is off");
		expect(text).toContain("No prompt caching was reported");
	});

	it("lists per-model costs and cache re-billing", () => {
		const text = stripAnsi(
			formatUsageReport(
				input({
					breakdown: [
						{ key: "codeify/gpt-a", cost: 0.1, tokens: 1_000 },
						{ key: "Tools/summaries", cost: 0.0234, tokens: 200 },
					],
					cacheWaste: { missedTokens: 12_000, missCount: 3, missedCost: 0.012 },
				}),
			),
		);
		expect(text).toContain("codeify/gpt-a: $0.100 for 1,000 tokens");
		expect(text).toContain("Tools/summaries: $0.023 for 200 tokens");
		expect(text).toContain(
			"Because of 3 cache misses, 12,000 tokens had to be billed again, costing about $0.012 extra.",
		);
	});
});
