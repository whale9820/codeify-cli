import type { TextContent } from "codeify-ai";
import { Container, Spacer, Text } from "codeify-tui";
import type { BackgroundTask } from "../../../core/background-tasks.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { theme } from "../theme/theme.ts";

const COLLAPSED_LINES = 5;

export class BackgroundTaskMessageComponent extends Container {
	private message: CustomMessage<unknown>;
	private expanded = false;

	constructor(message: CustomMessage<unknown>) {
		super();
		this.message = message;
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded !== expanded) {
			this.expanded = expanded;
			this.rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Spacer(1));

		const task = this.message.details as BackgroundTask | undefined;
		const content = this.message.content;
		const text =
			typeof content === "string"
				? content
				: content
						.filter((c): c is TextContent => c.type === "text")
						.map((c) => c.text)
						.join("\n");

		const failed = task ? task.status === "failed" : false;
		const dot = theme.fg(failed ? "error" : "success", "●");
		const seconds = task ? `${(((task.endedAt ?? Date.now()) - task.startedAt) / 1000).toFixed(1)}s` : "";
		const status = task ? task.status : "finished";
		const exit = task && task.exitCode !== undefined && task.exitCode !== null ? ` exit ${task.exitCode}` : "";
		const title = task ? `${theme.bold("Background task")} ${task.id}` : theme.bold("Background task");
		const meta = theme.fg("dim", `${status}${exit} ${seconds}`.trim());
		this.addChild(new Text(`${dot} ${title} ${meta}`, 0, 0));
		if (task?.description) this.addChild(new Text(`  ${theme.fg("muted", task.description)}`, 0, 0));

		const body = text
			.split("\n")
			.slice(1)
			.filter((line) => line !== "Output:" && line !== "Output (tail):");
		while (body.length > 0 && body[0].trim() === "") body.shift();
		if (body.length === 0) return;

		const shown = this.expanded ? body : body.slice(-COLLAPSED_LINES);
		const hidden = body.length - shown.length;
		const lines = shown.map((line) => theme.fg("toolOutput", line));
		if (hidden > 0) lines.unshift(theme.fg("dim", `... ${hidden} earlier lines`));
		const prefix = `  ${theme.fg("dim", "⎿")}  `;
		const rest = "     ";
		this.addChild(new Text(lines.map((line, i) => (i === 0 ? prefix : rest) + line).join("\n"), 0, 0));
	}
}
