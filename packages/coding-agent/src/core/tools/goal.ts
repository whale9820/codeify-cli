import type { AgentToolResult } from "codeify-agent-core";
import { Text } from "codeify-tui";
import { type Static, Type } from "typebox";
import type { Goal } from "../goal.ts";
import { defineTool, type ToolDefinition } from "./types.ts";

const updateGoalSchema = Type.Object({
	status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")], {
		description:
			'"complete" only when the goal is fully achieved and verified. "blocked" when you cannot continue without input or a decision from the user.',
	}),
	summary: Type.Optional(
		Type.String({
			description:
				"For complete: what was accomplished and how it was verified. For blocked: what you need from the user.",
		}),
	),
});

export type UpdateGoalToolInput = Static<typeof updateGoalSchema>;

export interface UpdateGoalToolDetails {
	goal?: Goal;
}

export interface UpdateGoalOperations {
	getGoal: () => Goal | undefined;
	completeGoal: (summary: string | undefined) => void;
	blockGoal: (reason: string | undefined) => void;
}

export function createUpdateGoalToolDefinition(
	ops: UpdateGoalOperations,
): ToolDefinition<typeof updateGoalSchema, UpdateGoalToolDetails> {
	return defineTool({
		name: "update_goal",
		label: "Goal",
		description: [
			"Finish work on the user's active goal, either as complete or as blocked.",
			"",
			'Use status "complete" only when a goal set with /goal is fully achieved and you have verified the result. Use status "blocked" when you cannot make further progress without input or a decision from the user; this pauses the goal and hands control back to them. Never keep working or keep stopping silently when blocked.',
		].join("\n"),
		promptSnippet:
			'Finish the active /goal objective: status "complete" once achieved and verified, or "blocked" when you need input from the user.',
		parameters: updateGoalSchema,
		async execute(_toolCallId, params, _signal): Promise<AgentToolResult<UpdateGoalToolDetails>> {
			const goal = ops.getGoal();
			if (!goal || goal.status !== "active") {
				return {
					content: [{ type: "text", text: "There is no active goal to complete." }],
					details: {},
				};
			}
			if (params.status === "blocked") {
				ops.blockGoal(params.summary);
				return {
					content: [
						{ type: "text", text: "Goal paused as blocked. Explain to the user what you need, then stop." },
					],
					details: { goal: ops.getGoal() },
				};
			}
			ops.completeGoal(params.summary);
			return {
				content: [{ type: "text", text: `Goal marked complete: ${goal.objective}` }],
				details: { goal: ops.getGoal() },
			};
		},
		renderCall(args, theme) {
			const suffix = args?.summary ? ` · ${args.summary}` : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold(args?.status === "blocked" ? "goal blocked" : "goal complete"))}${theme.fg("toolOutput", suffix)}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text = result.content.find((block) => block.type === "text");
			return new Text(theme.fg("toolOutput", text?.type === "text" ? text.text : ""), 0, 0);
		},
	});
}
