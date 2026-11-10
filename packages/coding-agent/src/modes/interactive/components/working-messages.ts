/** What the agent is currently doing, used to pick a status indicator message. */
export type WorkingActivity =
	| { kind: "waiting" }
	| { kind: "thinking" }
	| { kind: "writing" }
	| { kind: "tool"; toolName: string };

type MessagePool = { plain: readonly string[]; fun: readonly string[] };

const WAITING: MessagePool = {
	plain: ["Working", "Thinking", "Considering", "Planning"],
	fun: [
		"Percolating",
		"Noodling",
		"Cogitating",
		"Ruminating",
		"Mulling",
		"Brewing",
		"Marinating",
		"Simmering",
		"Conjuring",
		"Scheming",
		"Spelunking",
		"Moseying",
		"Booping",
		"Wrangling",
		"Finagling",
		"Hatching",
		"Puzzling",
		"Tinkering",
		"Whirring",
		"Vibing",
	],
};

const THINKING: MessagePool = {
	plain: ["Thinking", "Reasoning", "Analyzing", "Considering", "Deliberating"],
	fun: [
		"Pondering",
		"Contemplating",
		"Cogitating",
		"Ruminating",
		"Philosophizing",
		"Brainstorming",
		"Untangling",
		"Connecting dots",
		"Overthinking",
		"Consulting the void",
		"Galaxy-braining",
		"Daydreaming productively",
	],
};

const WRITING: MessagePool = {
	plain: ["Writing", "Responding", "Composing", "Drafting"],
	fun: [
		"Scribbling",
		"Wordsmithing",
		"Typing furiously",
		"Penning",
		"Spinning a yarn",
		"Articulating",
		"Crafting prose",
	],
};

const TOOL_POOLS: Record<string, MessagePool> = {
	read: {
		plain: ["Reading", "Inspecting", "Reviewing"],
		fun: ["Perusing", "Skimming", "Squinting at code", "Studying", "Absorbing", "Leafing through"],
	},
	edit: {
		plain: ["Editing", "Updating", "Modifying"],
		fun: ["Tweaking", "Patching", "Refactoring", "Polishing", "Nudging bytes", "Surgically altering", "Finessing"],
	},
	write: {
		plain: ["Writing", "Creating file", "Saving"],
		fun: ["Scribing", "Inking", "Manifesting", "Materializing", "Committing to disk", "Laying bricks"],
	},
	bash: {
		plain: ["Running", "Executing", "Running command"],
		fun: ["Shelling out", "Piping", "Crunching", "Spinning up", "Bashing", "Summoning processes", "Hammering keys"],
	},
	grep: {
		plain: ["Searching", "Grepping", "Scanning"],
		fun: ["Hunting", "Sleuthing", "Combing through", "Digging", "Sniffing around", "Detecting"],
	},
	find: {
		plain: ["Finding files", "Searching", "Locating"],
		fun: ["Foraging", "Scouting", "Rummaging", "Treasure hunting", "Exploring"],
	},
	ls: {
		plain: ["Listing", "Browsing directory"],
		fun: ["Looking around", "Surveying", "Peeking", "Taking inventory"],
	},
	web_search: {
		plain: ["Searching the web", "Looking it up", "Researching"],
		fun: ["Googling", "Surfing", "Consulting the internet", "Asking the oracle", "Trawling the web"],
	},
	browser: {
		plain: ["Browsing", "Navigating", "Loading page"],
		fun: ["Clicking around", "Surfing", "Scrolling", "Window shopping", "Poking the DOM"],
	},
	ssh: {
		plain: ["Running remotely", "Connecting", "Executing remotely"],
		fun: ["Tunneling", "Phoning home", "Teleporting", "Beaming commands"],
	},
	ssh_manage: {
		plain: ["Managing SSH profiles", "Configuring"],
		fun: ["Juggling keys", "Organizing hosts"],
	},
	background_task: {
		plain: ["Managing tasks", "Delegating", "Checking tasks"],
		fun: ["Multitasking", "Spinning plates", "Juggling"],
	},
	codeify_model: {
		plain: ["Delegating", "Handing off", "Coordinating"],
		fun: ["Recruiting help", "Calling in backup", "Assembling the team", "Outsourcing"],
	},
	mcp: {
		plain: ["Calling MCP server", "Using tools", "Connecting"],
		fun: ["Plugging in", "Patching through", "Wiring up"],
	},
	context_usage: {
		plain: ["Checking context", "Measuring usage"],
		fun: ["Counting tokens", "Taking stock", "Weighing memories"],
	},
	update_goal: {
		plain: ["Updating goal", "Wrapping up"],
		fun: ["Checking boxes", "Crossing the finish line"],
	},
	request_user_input: {
		plain: ["Asking you", "Preparing questions"],
		fun: ["Raising a hand", "Seeking wisdom"],
	},
};

const GENERIC_TOOL: MessagePool = {
	plain: ["Running tool", "Working", "Processing"],
	fun: ["Fiddling", "Operating", "Tinkering", "Doing the thing", "Whirring"],
};

/** Probability of choosing a playful variant over a plain one. */
const FUN_CHANCE = 0.4;

function poolFor(activity: WorkingActivity): MessagePool {
	switch (activity.kind) {
		case "waiting":
			return WAITING;
		case "thinking":
			return THINKING;
		case "writing":
			return WRITING;
		case "tool":
			return TOOL_POOLS[activity.toolName] ?? GENERIC_TOOL;
	}
}

function pick(items: readonly string[], random: () => number, avoid?: string): string {
	const candidates = items.length > 1 && avoid ? items.filter((item) => item !== avoid) : items;
	return candidates[Math.floor(random() * candidates.length)] ?? items[0] ?? "Working";
}

/** Key identifying an activity, so callers can tell when the activity changed. */
export function workingActivityKey(activity: WorkingActivity): string {
	return activity.kind === "tool" ? `tool:${activity.toolName}` : activity.kind;
}

/**
 * Pick a status verb for the activity, e.g. "Editing" or "Squinting at code".
 * Pass the previous verb as `avoid` to prevent immediate repeats.
 */
export function pickWorkingVerb(activity: WorkingActivity, avoid?: string, random: () => number = Math.random): string {
	const pool = poolFor(activity);
	const items = pool.fun.length > 0 && random() < FUN_CHANCE ? pool.fun : pool.plain;
	return pick(items, random, avoid);
}
