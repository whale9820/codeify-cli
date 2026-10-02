import { Container, getKeybindings, Spacer, Text, type TUI } from "codeify-tui";
import { type BackgroundTask, formatTaskLine } from "../../../core/background-tasks.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../../utils/shell.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

const FOLLOW_LINES = 18;
const REFRESH_MS = 400;

export interface TaskFollowOptions {
	tui: TUI;
	taskId: string;
	getTask: (id: string) => BackgroundTask | undefined;
	getOutput: (id: string) => { text: string; droppedChars: number } | undefined;
	onStop: (id: string) => void;
	onClose: () => void;
}

/** Live tail of one background task. Esc closes it, x stops the task. */
export class TaskFollowComponent extends Container {
	private body = new Text("", 1, 0);
	private title = new Text("", 1, 0);
	private hint = new Text("", 1, 0);
	private interval: ReturnType<typeof setInterval> | undefined;
	private options: TaskFollowOptions;

	constructor(options: TaskFollowOptions) {
		super();
		this.options = options;
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(this.title);
		this.addChild(new Spacer(1));
		this.addChild(this.body);
		this.addChild(new Spacer(1));
		this.addChild(this.hint);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.refresh();
		this.interval = setInterval(() => {
			this.refresh();
			options.tui.requestRender();
		}, REFRESH_MS);
	}

	private refresh(): void {
		const task = this.options.getTask(this.options.taskId);
		const output = this.options.getOutput(this.options.taskId);
		if (!task || !output) {
			this.title.setText(theme.fg("warning", `Task ${this.options.taskId} no longer exists`));
			this.body.setText("");
			this.hint.setText(keyHint("tui.select.cancel", "close"));
			return;
		}
		const running = task.status === "running";
		this.title.setText(theme.fg("accent", theme.bold(formatTaskLine(task))));
		const clean = sanitizeBinaryOutput(stripAnsi(output.text)).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		const lines = clean.trimEnd().split("\n");
		const shown = lines.slice(-FOLLOW_LINES);
		const hidden = lines.length - shown.length;
		const text = clean.trim()
			? shown.map((line) => theme.fg("toolOutput", line)).join("\n")
			: theme.fg("muted", "(no output yet)");
		this.body.setText(hidden > 0 ? `${theme.fg("muted", `... ${hidden} earlier lines`)}\n${text}` : text);
		this.hint.setText(
			`${running ? `${rawKeyHint("x", "stop")}  ` : ""}${keyHint("tui.select.cancel", "close")}${running ? theme.fg("muted", "  (live)") : ""}`,
		);
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (keyData === "x") {
			this.options.onStop(this.options.taskId);
			this.refresh();
			this.options.tui.requestRender();
		} else if (
			kb.matches(keyData, "tui.select.cancel") ||
			kb.matches(keyData, "tui.select.confirm") ||
			keyData === "q"
		) {
			this.onClose();
		}
	}

	private onClose(): void {
		this.dispose();
		this.options.onClose();
	}

	dispose(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = undefined;
		}
	}
}
