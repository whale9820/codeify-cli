import { type Component, Loader, type LoaderIndicatorOptions, type TUI } from "codeify-tui";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { keyText } from "./keybinding-hints.ts";
import { pickWorkingVerb, type WorkingActivity, workingActivityKey } from "./working-messages.ts";

const WORKING_ROTATE_MS = 8000;

export type StatusIndicatorKind = "working" | "retry" | "compaction" | "branchSummary" | "check";

export class StatusIndicator extends Loader {
	readonly kind: StatusIndicatorKind;

	constructor(
		kind: StatusIndicatorKind,
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: (str: string) => string,
		message: string,
		indicator?: LoaderIndicatorOptions,
	) {
		super(ui, spinnerColorFn, messageColorFn, message, indicator);
		this.kind = kind;
	}

	dispose(): void {
		this.stop();
	}
}

/**
 * Working indicator whose message reflects the current activity (thinking, writing, editing, ...).
 * The verb rotates periodically while the activity stays the same.
 */
export class WorkingStatusIndicator extends StatusIndicator {
	private activity: WorkingActivity;
	private verb: string;
	private rotateTimer: NodeJS.Timeout | undefined;

	constructor(ui: TUI, activity: WorkingActivity = { kind: "waiting" }, indicator?: LoaderIndicatorOptions) {
		const verb = pickWorkingVerb(activity);
		super(
			"working",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			`${verb}...`,
			indicator,
		);
		this.activity = activity;
		this.verb = verb;
		this.scheduleRotation();
	}

	/** Switch to a new activity. No-op if the activity is unchanged. */
	setActivity(activity: WorkingActivity): void {
		if (workingActivityKey(activity) === workingActivityKey(this.activity)) return;
		this.activity = activity;
		this.updateVerb();
		this.scheduleRotation();
	}

	private updateVerb(): void {
		this.verb = pickWorkingVerb(this.activity, this.verb);
		this.setMessage(`${this.verb}...`);
	}

	private scheduleRotation(): void {
		if (this.rotateTimer) clearInterval(this.rotateTimer);
		this.rotateTimer = setInterval(() => this.updateVerb(), WORKING_ROTATE_MS);
		this.rotateTimer.unref?.();
	}

	override dispose(): void {
		if (this.rotateTimer) clearInterval(this.rotateTimer);
		this.rotateTimer = undefined;
		super.dispose();
	}
}

export class ReconnectStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, attempt: number, maxAttempts: number) {
		super(
			"retry",
			ui,
			(spinner) => theme.fg("warning", spinner),
			(text) => theme.fg("muted", text),
			`Reconnecting (${attempt}/${maxAttempts})... (${keyText("app.interrupt")} to cancel)`,
		);
	}
}

export class RetryStatusIndicator extends StatusIndicator {
	private countdown: CountdownTimer | undefined;

	constructor(ui: TUI, attempt: number, maxAttempts: number, delayMs: number) {
		const retryMessage = (seconds: number) =>
			`Retrying (${attempt}/${maxAttempts}) in ${seconds}s... (${keyText("app.interrupt")} to cancel)`;
		super(
			"retry",
			ui,
			(spinner) => theme.fg("warning", spinner),
			(text) => theme.fg("muted", text),
			retryMessage(Math.ceil(delayMs / 1000)),
		);
		this.countdown = new CountdownTimer(
			delayMs,
			ui,
			(seconds) => {
				this.setMessage(retryMessage(seconds));
			},
			() => {
				this.countdown = undefined;
			},
		);
	}

	override dispose(): void {
		this.countdown?.dispose();
		this.countdown = undefined;
		super.dispose();
	}
}

export type CompactionStatusReason = "manual" | "threshold" | "overflow";

export class CompactionStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, reason: CompactionStatusReason) {
		const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
		const label =
			reason === "manual"
				? `Compacting context... ${cancelHint}`
				: `${reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... ${cancelHint}`;
		super(
			"compaction",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			label,
		);
	}
}

export class BranchSummaryStatusIndicator extends StatusIndicator {
	constructor(ui: TUI) {
		super(
			"branchSummary",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			`Summarizing branch... (${keyText("app.interrupt")} to cancel)`,
		);
	}
}

export class CheckStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, message: string) {
		super(
			"check",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			message,
		);
	}
}

export class IdleStatus implements Component {
	invalidate(): void {
		// No cached state to invalidate.
	}

	render(width: number): string[] {
		const emptyLine = " ".repeat(width);
		return [emptyLine, emptyLine];
	}
}
