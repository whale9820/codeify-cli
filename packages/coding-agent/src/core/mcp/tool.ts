import type { AgentToolResult } from "codeify-agent-core";
import type { ImageContent, TextContent } from "codeify-ai";
import { Text } from "codeify-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { type AnyToolDefinition, defineTool } from "../tools/types.ts";
import type { McpContentBlock, McpManager, McpToolInfo } from "./manager.ts";

const mcpSchema = Type.Object({
	tool: Type.Optional(Type.String({ description: "MCP tool name to call" })),
	args: Type.Optional(
		Type.String({ description: 'Tool arguments as a JSON object string, e.g. \'{"key": "value"}\'' }),
	),
	connect: Type.Optional(Type.String({ description: "Server name to connect to and list its tools" })),
	describe: Type.Optional(Type.String({ description: "Tool name to describe (shows its parameter schema)" })),
	search: Type.Optional(Type.String({ description: "Search available tools by name or description" })),
	server: Type.Optional(Type.String({ description: "Server name to filter a listing or disambiguate a tool call" })),
});

type McpToolInput = Static<typeof mcpSchema>;

interface McpToolDetails {
	mode: string;
	server?: string;
	tool?: string;
	isError?: boolean;
	text: string;
}

function result(text: string, details: Omit<McpToolDetails, "text">): AgentToolResult<McpToolDetails> {
	return { content: [{ type: "text", text }], details: { ...details, text } };
}

function mcpContentToBlocks(content: McpContentBlock[]): (TextContent | ImageContent)[] {
	const blocks: (TextContent | ImageContent)[] = [];
	for (const item of content) {
		if (item.type === "text") {
			blocks.push({ type: "text", text: typeof item.text === "string" ? item.text : JSON.stringify(item) });
		} else if (item.type === "image") {
			const data = typeof item.data === "string" ? item.data : "";
			blocks.push({
				type: "image",
				data,
				mimeType: typeof item.mimeType === "string" ? item.mimeType : "image/png",
			});
		} else if (item.type === "resource") {
			const resource = item.resource;
			const uri = resource?.uri ?? "(no URI)";
			const body = resource?.text ?? JSON.stringify(resource ?? {});
			blocks.push({ type: "text", text: `[Resource: ${uri}]\n${body}` });
		} else {
			blocks.push({ type: "text", text: JSON.stringify(item) });
		}
	}
	if (blocks.length === 0) {
		blocks.push({ type: "text", text: "(no content returned)" });
	}
	return blocks;
}

function formatToolLine(tool: McpToolInfo): string {
	const description = tool.description ? ` — ${tool.description}` : "";
	return `- ${tool.name}${description}`;
}

function buildDescription(serverNames: string[]): string {
	const serverList = serverNames.length > 0 ? serverNames.join(", ") : "(none configured)";
	return [
		"Gateway to configured MCP (Model Context Protocol) servers.",
		`Configured servers: ${serverList}.`,
		"",
		"Usage:",
		"- No arguments: show server status.",
		'- connect: "<server>" — connect to a server and list its tools.',
		'- server: "<server>" — list a specific server\'s tools.',
		'- search: "<query>" — search tools across servers by name or description.',
		'- describe: "<tool>" — show a tool\'s parameter schema.',
		'- tool: "<tool>", args: \'{...}\' — call a tool. Add server: "<server>" to disambiguate.',
	].join("\n");
}

function formatMcpCall(args: McpToolInput | undefined, theme: Theme): string {
	let operation = "status";
	if (args?.connect) {
		operation = `connect ${args.connect}`;
	} else if (args?.tool) {
		operation = `call ${args.server ? `${args.server} / ` : ""}${args.tool}`;
	} else if (args?.describe) {
		operation = `describe ${args.server ? `${args.server} / ` : ""}${args.describe}`;
	} else if (args?.search) {
		operation = `search "${args.search}"${args.server ? ` · ${args.server}` : ""}`;
	} else if (args?.server) {
		operation = `list ${args.server}`;
	}

	let text = `${theme.fg("toolTitle", theme.bold("mcp"))} ${theme.fg("toolOutput", operation)}`;
	if (args?.tool && args.args?.trim()) {
		let preview = args.args.trim();
		try {
			preview = JSON.stringify(JSON.parse(preview));
		} catch {}
		if (preview.length > 500) preview = `${preview.slice(0, 497)}...`;
		text += `\n${theme.fg("muted", preview)}`;
	}
	return text;
}

export function createMcpToolDefinition(manager: McpManager, serverNames: string[]): AnyToolDefinition {
	return defineTool({
		name: "mcp",
		label: "MCP",
		description: buildDescription(serverNames),
		promptSnippet: "Gateway to MCP servers: connect, list, search, describe, and call their tools.",
		parameters: mcpSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal) {
			let parsedArgs: Record<string, unknown> | undefined;
			if (params.args !== undefined) {
				try {
					const parsed = JSON.parse(params.args);
					if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
						return result("Invalid args: expected a JSON object string.", { mode: "call", isError: true });
					}
					parsedArgs = parsed as Record<string, unknown>;
				} catch (error) {
					return result(`Invalid args JSON: ${error instanceof Error ? error.message : String(error)}`, {
						mode: "call",
						isError: true,
					});
				}
			}

			try {
				if (params.connect) {
					if (!manager.hasServer(params.connect)) {
						return result(
							`Unknown MCP server "${params.connect}". Configured: ${manager.serverNames.join(", ")}.`,
							{
								mode: "connect",
								server: params.connect,
								isError: true,
							},
						);
					}
					const tools = await manager.refreshTools(params.connect);
					const lines = [
						`Connected to "${params.connect}" (${tools.length} tools):`,
						...tools.map(formatToolLine),
					];
					return result(lines.join("\n"), { mode: "connect", server: params.connect });
				}

				if (params.tool) {
					const callResult = await manager.callTool(params.tool, parsedArgs, params.server);
					const blocks = mcpContentToBlocks(callResult.content);
					const text = blocks.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
					return {
						content: blocks,
						details: {
							mode: "call",
							tool: params.tool,
							server: params.server,
							isError: callResult.isError,
							text,
						},
					};
				}

				if (params.describe) {
					const tools = await manager.listTools(params.server);
					const match = tools.find((tool) => tool.name === params.describe);
					if (!match) {
						return result(
							`Tool "${params.describe}" not found.${params.server ? ` (server: ${params.server})` : ""}`,
							{
								mode: "describe",
								tool: params.describe,
								isError: true,
							},
						);
					}
					const schema = JSON.stringify(match.inputSchema ?? {}, null, 2);
					const text = `${match.server} / ${match.name}\n${match.description ?? "(no description)"}\n\nParameters:\n${schema}`;
					return result(text, { mode: "describe", tool: match.name, server: match.server });
				}

				if (params.search) {
					const query = params.search.toLowerCase();
					const tools = await manager.listTools(params.server);
					const matches = tools.filter(
						(tool) =>
							tool.name.toLowerCase().includes(query) ||
							(tool.description?.toLowerCase().includes(query) ?? false),
					);
					if (matches.length === 0) {
						return result(`No tools matched "${params.search}".`, { mode: "search" });
					}
					const lines = [
						`Found ${matches.length} tool(s):`,
						...matches.map((tool) => `- [${tool.server}] ${formatToolLine(tool)}`),
					];
					return result(lines.join("\n"), { mode: "search" });
				}

				if (params.server) {
					if (!manager.hasServer(params.server)) {
						return result(
							`Unknown MCP server "${params.server}". Configured: ${manager.serverNames.join(", ")}.`,
							{
								mode: "list",
								server: params.server,
								isError: true,
							},
						);
					}
					const tools = await manager.refreshTools(params.server);
					const lines = [`"${params.server}" (${tools.length} tools):`, ...tools.map(formatToolLine)];
					return result(lines.join("\n"), { mode: "list", server: params.server });
				}

				const lines: string[] = ["MCP servers:"];
				for (const name of manager.serverNames) {
					const connected = manager.isConnected(name);
					const toolCount = manager.cachedTools(name).length;
					lines.push(connected ? `- ${name} (connected, ${toolCount} tools)` : `- ${name} (not connected)`);
				}
				lines.push("", 'Use connect:"<server>" to connect and list tools, or search:"<query>" to find a tool.');
				return result(lines.join("\n"), { mode: "status" });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return result(`MCP error: ${message}`, {
					mode: params.tool ? "call" : "status",
					tool: params.tool,
					server: params.server,
					isError: true,
				});
			}
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatMcpCall(args, theme));
			return text;
		},
	});
}
