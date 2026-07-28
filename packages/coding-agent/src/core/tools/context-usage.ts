import type { AgentToolResult } from "codeify-agent-core";
import { Text } from "codeify-tui";
import { type Static, Type } from "typebox";
import { defineTool, type ToolDefinition } from "./types.ts";

const contextUsageSchema = Type.Object({
	request_compaction: Type.Optional(
		Type.Boolean({
			description:
				"Ask the user to approve compacting the session. Only set this after the user has agreed, or to raise the question when usage is high. Compaction cannot be performed without user approval.",
		}),
	),
});

export type ContextUsageToolInput = Static<typeof contextUsageSchema>;

export interface ContextUsageSnapshot {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
	/** Turns recorded on the current branch. */
	turns: number;
	/** True when a compaction has already run on this branch. */
	compacted: boolean;
	/** Cumulative cost of the session in USD, when the provider reports it. */
	costUsd?: number;
}

export interface ContextUsageToolDetails {
	snapshot?: ContextUsageSnapshot;
	compactionRequested?: boolean;
}

export interface ContextUsageOperations {
	getSnapshot: () => ContextUsageSnapshot | undefined;
	/**
	 * Register a user-facing request to compact. The host decides how to prompt and runs
	 * compaction only on approval, after the current turn settles.
	 */
	requestCompaction: (rationale: string) => void;
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(tokens);
}

/**
 * Explain what the current transcript size implies for cost.
 *
 * Every turn re-sends the whole transcript, so spend grows with the square of session
 * length. A model that can see this number can decide to wrap up or ask to compact
 * instead of paging through a growing context.
 */
function costGuidance(snapshot: ContextUsageSnapshot): string[] {
	const lines: string[] = [];
	if (snapshot.tokens === null) {
		lines.push("Context size is unknown until the next model response completes.");
		return lines;
	}

	const perTurn = snapshot.tokens;
	lines.push(
		`Every additional turn re-sends about ${formatTokens(perTurn)} tokens, because the whole transcript is resent each time.`,
	);
	if (snapshot.percent !== null && snapshot.percent >= 50) {
		lines.push(
			"Usage is past half the window. Prefer narrow, targeted tool calls over broad reads, and consider asking the user whether to compact.",
		);
	} else if (snapshot.percent !== null && snapshot.percent >= 25) {
		lines.push("Keep tool results small from here; avoid full-file reads and large dumps.");
	}
	return lines;
}

export function createContextUsageToolDefinition(
	ops: ContextUsageOperations,
): ToolDefinition<typeof contextUsageSchema, ContextUsageToolDetails> {
	return defineTool({
		name: "context_usage",
		label: "Context",
		description: [
			"Report how much of the model context window this session is currently using, and what that costs per turn.",
			"",
			"The full transcript is resent to the model on every turn, so a long session costs far more per turn than a short one.",
			"Use this when deciding whether to keep working in this session, when a tool returned much more than expected, or when the user asks about token usage or cost.",
			"",
			"Set request_compaction: true to ask the user for approval to compact. Compaction summarizes older turns and frees context; it never happens without the user agreeing. Explain why you are asking in your message to the user.",
		].join("\n"),
		promptSnippet: "Check context window usage and per-turn token cost; can ask the user to approve compaction.",
		parameters: contextUsageSchema,
		async execute(_toolCallId, params, _signal): Promise<AgentToolResult<ContextUsageToolDetails>> {
			const snapshot = ops.getSnapshot();
			if (!snapshot) {
				return {
					content: [{ type: "text", text: "Context usage is unavailable (no model selected)." }],
					details: {},
				};
			}

			const lines: string[] = [];
			const used =
				snapshot.tokens === null
					? "unknown"
					: `${formatTokens(snapshot.tokens)} of ${formatTokens(snapshot.contextWindow)}`;
			const percent = snapshot.percent === null ? "unknown" : `${snapshot.percent.toFixed(1)}%`;
			lines.push(`Context: ${used} (${percent})`);
			lines.push(`Turns on this branch: ${snapshot.turns}${snapshot.compacted ? " (already compacted once)" : ""}`);
			if (snapshot.costUsd !== undefined) {
				lines.push(`Session cost so far: $${snapshot.costUsd.toFixed(2)}`);
			}
			lines.push(...costGuidance(snapshot));

			if (params.request_compaction) {
				ops.requestCompaction(`Context at ${percent} (${used}) after ${snapshot.turns} turns.`);
				lines.push(
					"",
					"Asked the user to approve compaction. Do not assume it happened: if they approve, it runs after this turn and you will see a summary in place of the older turns. Continue without it unless told otherwise.",
				);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { snapshot, compactionRequested: params.request_compaction === true },
			};
		},
		renderCall(args, theme) {
			const suffix = args?.request_compaction ? " · request compaction" : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("context"))}${theme.fg("toolOutput", suffix)}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content.find((block) => block.type === "text");
			return new Text(theme.fg("toolOutput", text?.type === "text" ? text.text : ""), 0, 0);
		},
	});
}
