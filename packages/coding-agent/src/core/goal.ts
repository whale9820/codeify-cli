export type GoalStatus = "active" | "paused" | "complete";

export interface Goal {
	objective: string;
	status: GoalStatus;
	continuations: number;
	summary?: string;
}

export const MAX_GOAL_CONTINUATIONS = 50;

export function createGoal(objective: string): Goal {
	return { objective, status: "active", continuations: 0 };
}

export function buildGoalStartPrompt(goal: Goal): string {
	return [
		`Goal: ${goal.objective}`,
		"",
		"Work toward this goal autonomously. You will be prompted to keep going after each turn until the goal is achieved.",
		"Completion must be evidence based: check the objective against concrete evidence such as changed files, test or benchmark output, logs, or generated artifacts before declaring success.",
		'When the goal is fully achieved and verified, call the update_goal tool with status "complete" and a short summary.',
		"If you are blocked and need input from the user, say so plainly and stop; the user can pause or clear the goal.",
	].join("\n");
}

export function buildGoalContinuationPrompt(goal: Goal): string {
	return [
		`Continue working toward the active goal: ${goal.objective}`,
		"",
		"Review what has been done so far, pick the next most useful step, and carry it out using tools.",
		"Do not mark the goal complete because it seems probably done; audit it against concrete evidence first.",
		'If the goal is fully achieved and verified, call the update_goal tool with status "complete" and a short summary instead of continuing.',
		"If you are blocked and need input from the user, say so plainly and stop.",
	].join("\n");
}
