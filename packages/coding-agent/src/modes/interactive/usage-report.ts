import type { UsageCostBreakdownEntry } from "../../core/usage-totals.ts";
import { formatTokens } from "./components/footer.ts";
import { theme } from "./theme/theme.ts";

export interface UsageReportInput {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
	cost: number;
	assistantMessages: number;
	context?: { tokens: number | null; contextWindow: number; percent: number | null };
	autoCompact: boolean;
	breakdown: UsageCostBreakdownEntry[];
	latestCacheHitRate?: number;
	cacheWaste: { missedTokens: number; missCount: number; missedCost: number };
	modelId?: string;
}

function count(value: number, singular: string): string {
	return `${value.toLocaleString()} ${singular}${value === 1 ? "" : "s"}`;
}

function section(title: string, lines: string[]): string {
	return `${theme.bold(title)}\n${lines.map((line) => `  ${line}`).join("\n")}`;
}

function contextSection(input: UsageReportInput): string {
	const context = input.context;
	if (!context) {
		return section("Context window", ["No model is selected, so the context window size is unknown."]);
	}
	const lines: string[] = [];
	const windowText = `${formatTokens(context.contextWindow)} token`;
	if (context.percent === null || context.tokens === null) {
		lines.push(
			`The size of the current conversation is not known yet because the context was just compacted. It will be measured after the next response. The window holds ${windowText}s.`,
		);
	} else {
		lines.push(
			`${context.percent.toFixed(1)}% of the ${windowText} window is in use (${context.tokens.toLocaleString()} tokens).`,
		);
	}
	lines.push(
		input.autoCompact
			? "Auto-compaction is on, so older turns are summarized automatically when the window fills up."
			: "Auto-compaction is off, so use /compact to free space when the window fills up.",
	);
	return section("Context window", lines);
}

function sessionSection(input: UsageReportInput): string {
	const { tokens } = input;
	const promptTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite;
	const lines = [
		`The model has produced ${count(input.assistantMessages, "response")}${input.modelId ? `, most recently with ${input.modelId}` : ""}.`,
		`It read ${count(promptTokens, "token")} of input and wrote ${count(tokens.output, "token")} of output.`,
	];
	if (promptTokens > 0 && (tokens.cacheRead > 0 || tokens.cacheWrite > 0)) {
		const share = ((tokens.cacheRead / promptTokens) * 100).toFixed(1);
		let cacheLine = `${count(tokens.cacheRead, "token")} of that input (${share}%) was served from the prompt cache`;
		cacheLine +=
			tokens.cacheWrite > 0
				? `, and ${count(tokens.cacheWrite, "token")} were written to the cache for later reuse.`
				: ".";
		lines.push(cacheLine);
		if (input.latestCacheHitRate !== undefined) {
			lines.push(`The most recent request had a cache hit rate of ${input.latestCacheHitRate.toFixed(0)}%.`);
		}
	} else if (promptTokens > 0) {
		lines.push("No prompt caching was reported for this session.");
	}
	return section("This session", lines);
}

function costSection(input: UsageReportInput): string {
	const lines: string[] = [];
	if (input.cost > 0) {
		lines.push(`This session has cost $${input.cost.toFixed(3)} so far.`);
		if (input.breakdown.length > 1) {
			for (const entry of input.breakdown) {
				lines.push(
					`${theme.fg("dim", "•")} ${entry.key}: $${entry.cost.toFixed(3)} for ${count(entry.tokens, "token")}`,
				);
			}
		}
	} else {
		lines.push("No per-token cost has been recorded for this session. This is normal on a subscription plan.");
	}
	const waste = input.cacheWaste;
	if (waste.missedTokens > 0) {
		const missText = waste.missCount === 1 ? "one cache miss" : `${waste.missCount.toLocaleString()} cache misses`;
		const price = waste.missedCost >= 0.0001 ? `, costing about $${waste.missedCost.toFixed(3)} extra` : "";
		lines.push(`Because of ${missText}, ${count(waste.missedTokens, "token")} had to be billed again${price}.`);
	}
	return section("Cost", lines);
}

export function formatUsageReport(input: UsageReportInput): string {
	return [contextSection(input), sessionSection(input), costSection(input)].join("\n\n");
}
