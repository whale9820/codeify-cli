import {
	type AssistantMessage,
	type CitationSource,
	isMalformedJsonError,
	isSafeguardBlock,
	NETWORK_UNSTABLE_ERROR_MESSAGE,
	renderInlineCitations,
	type ServerToolUse,
} from "codeify-ai";
import {
	type Component,
	Container,
	Markdown,
	type MarkdownTheme,
	Spacer,
	sliceByColumn,
	Text,
	truncateToWidth,
	visibleWidth,
} from "codeify-tui";
import { stripAnsi } from "../../../utils/ansi.ts";
import { separateAdjacentBold, splitWrappedThinking } from "../../../utils/thinking-text.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { ErrorDetailsComponent } from "./error-details.ts";
import { PrefixedComponent } from "./prefixed.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

class SingleLineThinking implements Component {
	private text: string;
	private padding: number;

	constructor(text: string, padding: number) {
		this.text = stripAnsi(text)
			.replace(/(\*\*|__|`)/g, "")
			.replace(/\s+/g, " ")
			.trim();
		this.padding = padding;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const prefix = `${" ".repeat(Math.min(this.padding, Math.max(0, width - 1)))}∴ `;
		const available = Math.max(0, width - visibleWidth(prefix));
		const textWidth = visibleWidth(this.text);
		const tail =
			textWidth > available
				? `…${sliceByColumn(this.text, textWidth - Math.max(0, available - 1), Math.max(0, available - 1), true)}`
				: this.text;
		return [theme.fg("thinkingText", truncateToWidth(prefix + tail, width, ""))];
	}
}

type ContentRenderItem =
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string }
	| { kind: "serverToolUse"; block: ServerToolUse };

/**
 * Flatten message content into ordered render items, splitting text blocks that
 * wrap reasoning in `<think>`/`<thinking>` tags into separate thinking items.
 * Consecutive thinking items are merged so they render as one block.
 */
function buildContentRenderItems(
	content: AssistantMessage["content"],
	sources: ReadonlyMap<string, CitationSource>,
): ContentRenderItem[] {
	const items: ContentRenderItem[] = [];

	for (const block of content) {
		if (block.type === "text") {
			const text = renderInlineCitations(block.text, sources, block.citations);
			for (const segment of splitWrappedThinking(text)) {
				items.push({ kind: segment.type, text: segment.text });
			}
		} else if (block.type === "thinking") {
			items.push({ kind: "thinking", text: block.thinking });
		} else if (block.type === "serverToolUse") {
			items.push({ kind: "serverToolUse", block });
		}
	}

	const merged: ContentRenderItem[] = [];
	for (const item of items) {
		const previous = merged[merged.length - 1];
		if (item.kind === "thinking" && previous?.kind === "thinking") {
			previous.text += `\n\n${item.text}`;
			continue;
		}
		merged.push({ ...item });
	}
	return merged;
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private shrinkThinking: boolean;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private expanded = false;
	private errorDetails?: ErrorDetailsComponent;
	private citationSources: ReadonlyMap<string, CitationSource> = new Map();

	constructor(
		message?: AssistantMessage,
		shrinkThinking = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
	) {
		super();

		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.shrinkThinking = shrinkThinking;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setShrinkThinking(shrink: boolean): void {
		if (this.shrinkThinking === shrink) return;
		this.shrinkThinking = shrink;
		if (this.lastMessage) this.updateContent(this.lastMessage);
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.errorDetails?.setExpanded(expanded);
	}

	setCitationSources(sources: ReadonlyMap<string, CitationSource>): void {
		this.citationSources = sources;
		if (this.lastMessage) this.updateContent(this.lastMessage);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;

		// Clear content container
		this.contentContainer.clear();

		let items = buildContentRenderItems(message.content, this.citationSources);
		if (this.shrinkThinking) {
			const latestThinking = [...items].reverse().find((item) => item.kind === "thinking" && item.text.trim());
			items = items.filter((item) => item.kind !== "thinking" || item === latestThinking);
		}

		const hasVisibleContent = items.some(
			(item) =>
				(item.kind === "text" && item.text.trim()) ||
				(item.kind === "thinking" && item.text.trim()) ||
				item.kind === "serverToolUse",
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const hasVisibleContentAfter = items
				.slice(i + 1)
				.some(
					(next) =>
						(next.kind === "text" && next.text.trim()) ||
						(next.kind === "thinking" && next.text.trim()) ||
						next.kind === "serverToolUse",
				);
			if (item.kind === "text") {
				if (item.text.trim()) {
					this.contentContainer.addChild(
						new PrefixedComponent(
							new Markdown(separateAdjacentBold(item.text.trim()), 0, 0, this.markdownTheme),
							`${theme.fg("text", "●")} `,
							"  ",
						),
					);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				}
			} else if (item.kind === "thinking") {
				if (item.text.trim()) {
					this.contentContainer.addChild(
						this.shrinkThinking
							? new SingleLineThinking(item.text, this.outputPad)
							: new Markdown(separateAdjacentBold(item.text.trim()), this.outputPad, 0, this.markdownTheme, {
									color: (text: string) => theme.fg("thinkingText", text),
									italic: true,
								}),
					);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				}
			} else {
				const content = item.block;
				const query = (content.input as { query?: string })?.query;
				const toolLabel = content.name === "web_search" ? "Web search" : content.name;
				const label = query ? `${toolLabel}: "${query}"` : toolLabel;
				this.contentContainer.addChild(new Text(theme.fg("muted", label), this.outputPad, 0));

				const contentIndex = message.content.indexOf(content);
				const nextBlock = message.content[contentIndex + 1];
				if (nextBlock && nextBlock.type === "serverToolResult" && nextBlock.toolUseId === content.id) {
					const resultCount = Array.isArray(nextBlock.content) ? nextBlock.content.length : 0;
					if (resultCount > 0) {
						this.contentContainer.addChild(
							new Text(
								theme.fg("dim", `  -> ${resultCount} result${resultCount === 1 ? "" : "s"}`),
								this.outputPad,
								0,
							),
						);
					}
				}
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(
					theme.fg(
						"error",
						"Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.",
					),
					this.outputPad,
					0,
				),
			);
		} else if (
			message.stopReason === "error" &&
			(isMalformedJsonError(message.errorMessage ?? "") ||
				message.diagnostics?.some((entry) => entry.type === "malformed_json"))
		) {
			const details =
				message.diagnostics?.find((entry) => entry.type === "malformed_json")?.error?.message ??
				message.errorMessage!;
			const payloads =
				message.diagnostics
					?.filter((entry) => entry.type === "malformed_json_payload")
					.map((entry) => entry.error?.message ?? "") ?? [];
			this.errorDetails = new ErrorDetailsComponent([details, ...payloads].join("\n"), this.outputPad);
			this.errorDetails.setExpanded(this.expanded);
			this.contentContainer.addChild(new Spacer(1));
			if (message.errorMessage === NETWORK_UNSTABLE_ERROR_MESSAGE) {
				this.contentContainer.addChild(
					new Text(theme.fg("error", NETWORK_UNSTABLE_ERROR_MESSAGE), this.outputPad, 0),
				);
			}
			this.contentContainer.addChild(this.errorDetails);
		} else if (message.stopReason === "error" && isSafeguardBlock(message.errorMessage)) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(theme.fg("error", message.errorMessage!), this.outputPad, 0));
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}
