import type { AgentToolResult } from "codeify-agent-core";
import { Text } from "codeify-tui";
import { type Static, Type } from "typebox";
import type { Goal } from "../goal.ts";
import { defineTool, type ToolDefinition } from "./types.ts";

const updateGoalSchema = Type.Object({
	status: Type.Literal("complete", {
		description: 'Set to "complete" only when the goal is fully achieved and verified.',
	}),
	summary: Type.Optional(
		Type.String({ description: "Short summary of what was accomplished and how it was verified." }),
	),
});

export type UpdateGoalToolInput = Static<typeof updateGoalSchema>;

export interface UpdateGoalToolDetails {
	goal?: Goal;
}

export interface UpdateGoalOperations {
	getGoal: () => Goal | undefined;
	completeGoal: (summary: string | undefined) => void;
}

export function createUpdateGoalToolDefinition(
	ops: UpdateGoalOperations,
): ToolDefinition<typeof updateGoalSchema, UpdateGoalToolDetails> {
	return defineTool({
		name: "update_goal",
		label: "Goal",
		description: [
			"Mark the user's active goal as complete.",
			"",
			"Use this only when a goal set with /goal is fully achieved and you have verified the result. Do not call it to give up or pause; if blocked, explain the blocker to the user instead.",
		].join("\n"),
		promptSnippet: "Mark the active /goal objective complete once it is achieved and verified.",
		parameters: updateGoalSchema,
		async execute(_toolCallId, params, _signal): Promise<AgentToolResult<UpdateGoalToolDetails>> {
			const goal = ops.getGoal();
			if (!goal || goal.status !== "active") {
				return {
					content: [{ type: "text", text: "There is no active goal to complete." }],
					details: {},
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
				`${theme.fg("toolTitle", theme.bold("goal complete"))}${theme.fg("toolOutput", suffix)}`,
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
