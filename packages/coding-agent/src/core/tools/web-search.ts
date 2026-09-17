import type { AgentTool } from "codeify-agent-core";
import { Text } from "codeify-tui";
import { type Static, Type } from "typebox";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "./types.ts";

const webSearchSchema = Type.Object({
	query: Type.String({ description: "Web search query to find up-to-date documentation, news, or answers." }),
});

export type WebSearchToolInput = Static<typeof webSearchSchema>;

export interface WebSearchToolDetails {
	query: string;
	resultsCount?: number;
}

export interface WebSearchToolOptions {
	description?: string;
}

function prepareWebSearchArguments(input: unknown): WebSearchToolInput {
	if (!input || typeof input !== "object") {
		return input as WebSearchToolInput;
	}

	const args = input as Record<string, unknown>;
	const query =
		typeof args.query === "string"
			? args.query
			: typeof args.Query === "string"
				? args.Query
				: typeof args.search_query === "string"
					? args.search_query
					: typeof args.q === "string"
						? args.q
						: args.query;

	return {
		...args,
		query,
	} as WebSearchToolInput;
}

export function createWebSearchToolDefinition(
	_cwd?: string,
	options?: WebSearchToolOptions,
): ToolDefinition<typeof webSearchSchema, WebSearchToolDetails> {
	return {
		name: "web_search",
		label: "web_search",
		description:
			options?.description ??
			"Search the web for up-to-date information, documentation, and news. When supported by the model provider, this is executed server-side.",
		parameters: webSearchSchema,
		prepareArguments: prepareWebSearchArguments,
		execute: async (_toolCallId, input) => {
			return {
				content: [
					{
						type: "text",
						text: `Web search for "${input.query}" is executed server-side by supported model providers. If your provider does not support server-side search, configure a search MCP server.`,
					},
				],
				details: {
					query: input.query,
				},
			};
		},
		renderCall(args, theme) {
			const query = args?.query ? ` "${args.query}"` : "";
			return new Text(theme.fg("toolTitle", "web_search") + theme.fg("muted", query));
		},
		renderResult(result, _options: ToolRenderResultOptions, theme) {
			const query = result.details?.query ? ` for "${result.details.query}"` : "";
			return new Text(theme.fg("toolOutput", `Web search executed${query}.`));
		},
	};
}

export function createWebSearchTool(cwd?: string, options?: WebSearchToolOptions): AgentTool<typeof webSearchSchema> {
	return wrapToolDefinition(createWebSearchToolDefinition(cwd, options));
}
