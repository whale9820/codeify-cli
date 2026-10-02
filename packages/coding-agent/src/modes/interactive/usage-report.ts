export interface UsageReportInput {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

function compact(value: number): string {
	if (value < 1000) return value.toString();
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

export function formatUsageReport(input: UsageReportInput): string {
	const { tokens } = input;
	return `${compact(tokens.input)} input, ${compact(tokens.output)} output, ${compact(tokens.cacheRead)} cache read, ${compact(tokens.cacheWrite)} cache write`;
}
