export interface UsageReportInput {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextUsage?: { tokens: number | null; contextWindow: number };
}

function compact(value: number): string {
	if (value < 1000) return value.toString();
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

export function formatUsageReport(input: UsageReportInput): string {
	const { tokens, contextUsage } = input;
	const contextTokens = contextUsage?.tokens == null ? "?" : compact(contextUsage.tokens);
	const contextWindow = contextUsage ? compact(contextUsage.contextWindow).replace(/\.0([km])$/, "$1") : "?";
	const promptTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite;
	const cachedPercent = promptTokens > 0 ? (tokens.cacheRead / promptTokens) * 100 : 0;
	return `${contextTokens}/${contextWindow} context, ${cachedPercent.toFixed(1)}% cached, ${compact(tokens.input)} input, ${compact(tokens.output)} output, ${compact(tokens.cacheRead)} cache read, ${compact(tokens.cacheWrite)} cache write`;
}
