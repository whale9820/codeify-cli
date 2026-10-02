export type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped";

export interface BackgroundTaskRunContext {
	signal: AbortSignal;
	append: (text: string) => void;
}

export interface BackgroundTask {
	id: string;
	kind: "command" | "agent";
	description: string;
	status: BackgroundTaskStatus;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	error?: string;
}

export interface BackgroundTaskRunResult {
	exitCode?: number | null;
	text?: string;
}

export interface BackgroundTaskStartOptions {
	kind: BackgroundTask["kind"];
	description: string;
	run: (context: BackgroundTaskRunContext) => Promise<BackgroundTaskRunResult | undefined>;
}

export interface BackgroundTaskAdoptOptions {
	kind: BackgroundTask["kind"];
	description: string;
	/** Output the running process already produced before it was moved to the background. */
	initialOutput?: string;
	/** Aborting this controller stops the process; the adopter must have wired it to the process. */
	controller: AbortController;
	/** Settles when the already-running process ends. */
	completion: Promise<BackgroundTaskRunResult | undefined>;
}

const MAX_OUTPUT_CHARS = 64_000;
export const MAX_RUNNING_BACKGROUND_TASKS = 8;

interface Entry {
	task: BackgroundTask;
	controller: AbortController;
	output: string;
	droppedChars: number;
	stopRequested: boolean;
	/** Absolute character offset (including dropped output) already returned by readNewOutput. */
	readCursor: number;
}

export class BackgroundTaskManager {
	private entries = new Map<string, Entry>();
	private nextId = 1;
	private onFinished: (task: BackgroundTask) => void;
	private onChange: () => void;

	constructor(onFinished: (task: BackgroundTask) => void, onChange: () => void = () => {}) {
		this.onFinished = onFinished;
		this.onChange = onChange;
	}

	start(options: BackgroundTaskStartOptions): BackgroundTask {
		if (this.runningCount() >= MAX_RUNNING_BACKGROUND_TASKS) {
			throw new Error(`At most ${MAX_RUNNING_BACKGROUND_TASKS} background tasks can run at once.`);
		}
		const controller = new AbortController();
		const entry = this.register(options.kind, options.description, controller, "");
		const append = (text: string) => this.appendOutput(entry, text);
		this.track(entry, options.run({ signal: controller.signal, append }));
		return entry.task;
	}

	/**
	 * Take over a process that is already running (for example a foreground bash command the
	 * user sent to the background). Returns the task and a function that feeds it further output.
	 */
	adopt(options: BackgroundTaskAdoptOptions): { task: BackgroundTask; append: (text: string) => void } {
		const entry = this.register(options.kind, options.description, options.controller, options.initialOutput ?? "");
		this.track(entry, options.completion);
		return { task: entry.task, append: (text) => this.appendOutput(entry, text) };
	}

	private register(
		kind: BackgroundTask["kind"],
		description: string,
		controller: AbortController,
		initialOutput: string,
	): Entry {
		const task: BackgroundTask = {
			id: `bg${this.nextId++}`,
			kind,
			description,
			status: "running",
			startedAt: Date.now(),
		};
		const entry: Entry = { task, controller, output: "", droppedChars: 0, stopRequested: false, readCursor: 0 };
		this.entries.set(task.id, entry);
		this.appendOutput(entry, initialOutput);
		this.onChange();
		return entry;
	}

	private appendOutput(entry: Entry, text: string): void {
		if (!text) return;
		entry.output += text;
		if (entry.output.length > MAX_OUTPUT_CHARS) {
			const excess = entry.output.length - MAX_OUTPUT_CHARS;
			entry.output = entry.output.slice(excess);
			entry.droppedChars += excess;
		}
	}

	private track(entry: Entry, completion: Promise<BackgroundTaskRunResult | undefined>): void {
		const append = (text: string) => this.appendOutput(entry, text);
		const finish = (status: BackgroundTaskStatus, patch: Partial<BackgroundTask>) => {
			if (entry.task.status !== "running") return;
			entry.task = { ...entry.task, ...patch, status, endedAt: Date.now() };
			this.onChange();
			this.onFinished(entry.task);
		};

		void completion
			.then((result) => {
				if (result?.text) append(result.text);
				if (entry.stopRequested) {
					finish("stopped", { exitCode: result?.exitCode });
				} else if (result?.exitCode !== undefined && result.exitCode !== 0) {
					finish("failed", { exitCode: result.exitCode });
				} else {
					finish("completed", { exitCode: result?.exitCode });
				}
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				if (entry.stopRequested) {
					finish("stopped", {});
				} else {
					finish("failed", { error: message });
				}
			});
	}

	/** Remove finished tasks from the list. Returns how many were removed. */
	clearFinished(): number {
		let removed = 0;
		for (const [id, entry] of this.entries) {
			if (entry.task.status === "running") continue;
			this.entries.delete(id);
			removed++;
		}
		if (removed > 0) this.onChange();
		return removed;
	}

	get(id: string): BackgroundTask | undefined {
		return this.entries.get(id)?.task;
	}

	list(): BackgroundTask[] {
		return [...this.entries.values()].map((entry) => entry.task);
	}

	runningCount(): number {
		return this.list().filter((task) => task.status === "running").length;
	}

	readOutput(id: string): { text: string; droppedChars: number } | undefined {
		const entry = this.entries.get(id);
		if (!entry) return undefined;
		return { text: entry.output, droppedChars: entry.droppedChars };
	}

	/** Output produced since the last readNewOutput call for this task (like Claude Code's BashOutput). */
	readNewOutput(id: string): { text: string; droppedChars: number } | undefined {
		const entry = this.entries.get(id);
		if (!entry) return undefined;
		const total = entry.droppedChars + entry.output.length;
		const start = Math.max(entry.readCursor, entry.droppedChars);
		const lost = start - entry.readCursor;
		const text = entry.output.slice(start - entry.droppedChars);
		entry.readCursor = total;
		return { text, droppedChars: lost };
	}

	stop(id: string): boolean {
		const entry = this.entries.get(id);
		if (!entry || entry.task.status !== "running") return false;
		entry.stopRequested = true;
		entry.controller.abort();
		return true;
	}

	stopAll(): void {
		for (const id of this.entries.keys()) this.stop(id);
	}

	detach(): void {
		this.onFinished = () => {};
		this.onChange = () => {};
		this.stopAll();
	}
}

export function formatTaskDuration(task: BackgroundTask): string {
	const end = task.endedAt ?? Date.now();
	return `${((end - task.startedAt) / 1000).toFixed(1)}s`;
}

export function formatTaskLine(task: BackgroundTask): string {
	const exit = task.exitCode !== undefined && task.exitCode !== null ? ` exit ${task.exitCode}` : "";
	return `${task.id} [${task.kind}] ${task.status}${exit} ${formatTaskDuration(task)} - ${task.description}`;
}

export function buildCompletionMessage(task: BackgroundTask, output: { text: string; droppedChars: number }): string {
	const tail = output.text.length > 8_000 ? output.text.slice(-8_000) : output.text;
	const truncated = output.droppedChars > 0 || tail.length < output.text.length;
	const lines = [`Background task ${formatTaskLine(task)}`];
	if (task.error) lines.push(`Error: ${task.error}`);
	if (tail.trim()) {
		lines.push(truncated ? "Output (tail):" : "Output:", tail.trimEnd());
	} else {
		lines.push("(no output)");
	}
	if (truncated) lines.push(`Use background_task with action "output" and id ${task.id} for more.`);
	return lines.join("\n");
}
