export type GoalStatus = "active" | "paused" | "complete";

export interface Goal {
	objective: string;
	status: GoalStatus;
	continuations: number;
	stalls: number;
	summary?: string;
}

export const MAX_GOAL_CONTINUATIONS = 50;
export const MAX_GOAL_STALLS = 3;

export function createGoal(objective: string): Goal {
	return { objective, status: "active", continuations: 0, stalls: 0 };
}

export function buildGoalStartPrompt(goal: Goal): string {
	return [
		`Goal: ${goal.objective}`,
		"",
		"Work toward this goal autonomously. You will be prompted to keep going after each turn until the goal is achieved.",
		"Completion must be evidence based: check the objective against concrete evidence such as changed files, test or benchmark output, logs, or generated artifacts before declaring success.",
		'When the goal is fully achieved and verified, call the update_goal tool with status "complete" and a short summary.',
		'If you are blocked and need input or a decision from the user, call update_goal with status "blocked" and say what you need; this pauses the goal so you are not prompted again.',
	].join("\n");
}

export function buildGoalContinuationPrompt(goal: Goal): string {
	return [
		`Continue working toward the active goal: ${goal.objective}`,
		"",
		"Review what has been done so far, pick the next most useful step, and carry it out using tools.",
		"Do not mark the goal complete because it seems probably done; audit it against concrete evidence first.",
		'If the goal is fully achieved and verified, call the update_goal tool with status "complete" and a short summary instead of continuing.',
		'If you are blocked and need input or a decision from the user, call update_goal with status "blocked" and say what you need.',
	].join("\n");
}

export function buildGoalStallPrompt(goal: Goal): string {
	return [
		`You stopped without finishing the active goal: ${goal.objective}`,
		"",
		'Do not stop or ask for confirmation. If you are genuinely blocked on input only the user can give, call update_goal with status "blocked". If the goal is already achieved and verified, call update_goal with status "complete". Otherwise resume the work now with the next concrete step.',
	].join("\n");
}
