import type { AgentToolResult } from "codeify-agent-core";
import type { ImageContent, TextContent } from "codeify-ai";
import { Text } from "codeify-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { processImage } from "../../utils/image-process.ts";
import { capOutputWithNotice } from "../tools/spill.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../tools/truncate.ts";
import { type AnyToolDefinition, defineTool } from "../tools/types.ts";
import type { McpContentBlock, McpManager, McpToolInfo } from "./manager.ts";

export interface McpToolOptions {
	autoResizeImages?: () => boolean;
}

// MCP servers commonly return full-resolution viewport captures (1920x1052 and up).
// Every such image is re-billed on every later turn of the session, so cap them well
// below the generic 2000px attachment limit before they enter the transcript.
const MCP_IMAGE_MAX_DIMENSION = 1024;

// Range parameter names used by this agent's own `read` tool. The system prompt tells the
// model to page large files with offset/limit, so it reaches for these names on MCP tools
// too. When the target tool does not declare them they are silently dropped, and a tool
// that defaults to returning everything sends back the whole file instead of the requested
// slice. That full payload is then re-billed on every later turn.
const NATIVE_RANGE_PARAMS = ["offset", "limit"];

interface SchemaShape {
	properties: Record<string, unknown>;
	booleanDefaultsTrue: string[];
}

function schemaShape(inputSchema: unknown): SchemaShape | null {
	if (typeof inputSchema !== "object" || inputSchema === null) return null;
	const properties = (inputSchema as { properties?: unknown }).properties;
	if (typeof properties !== "object" || properties === null) return null;
	const booleanDefaultsTrue: string[] = [];
	for (const [name, definition] of Object.entries(properties as Record<string, unknown>)) {
		if (typeof definition !== "object" || definition === null) continue;
		const {
			type,
			default: defaultValue,
			description,
		} = definition as {
			type?: unknown;
			default?: unknown;
			description?: unknown;
		};
		if (type !== "boolean") continue;
		// Servers express the default either as a JSON Schema `default` or only in prose.
		const describedAsDefaultTrue = typeof description === "string" && /defaults?\s+to\s+true/i.test(description);
		if (defaultValue === true || describedAsDefaultTrue) booleanDefaultsTrue.push(name);
	}
	return { properties: properties as Record<string, unknown>, booleanDefaultsTrue };
}

/**
 * Detect a call whose arguments express a bounded read but whose effective behavior is an
 * unbounded one. Returns guidance for the model, or undefined when the call is coherent.
 *
 * Two shapes are caught, both schema-valid and both silent on the server:
 * - Range parameters the target tool does not declare, so they are ignored entirely.
 * - Range parameters the tool does declare, alongside an unset boolean that defaults to
 *   true and overrides them.
 */
function describeIgnoredRangeArgs(
	toolName: string,
	args: Record<string, unknown> | undefined,
	inputSchema: unknown,
): string | undefined {
	if (!args) return undefined;
	const shape = schemaShape(inputSchema);
	if (!shape) return undefined;

	const unsupported = NATIVE_RANGE_PARAMS.filter((name) => name in args && !(name in shape.properties));
	const rangeParams = Object.keys(shape.properties).filter((name) => /(^|_)(start|end)(_|$)|line/i.test(name));
	const suppliedRangeParams = rangeParams.filter((name) => name in args);
	const overriding = shape.booleanDefaultsTrue.filter((name) => args[name] !== false);

	if (unsupported.length > 0) {
		const lines = [
			`Refused: "${toolName}" does not accept ${unsupported.map((name) => `\`${name}\``).join(" or ")}.`,
			"Unknown arguments are dropped silently, so this call would have returned the entire",
			"result instead of the range you asked for, and that full payload stays in context for",
			"the rest of the session.",
		];
		if (rangeParams.length > 0) {
			lines.push(`Use ${rangeParams.map((name) => `\`${name}\``).join(" and ")} instead.`);
		}
		if (overriding.length > 0) {
			lines.push(`Also set ${overriding.map((name) => `\`${name}\`: false`).join(", ")} or the range is ignored.`);
		}
		lines.push(`Call describe: "${toolName}" to see the full schema.`);
		return lines.join("\n");
	}

	if (suppliedRangeParams.length > 0 && overriding.length > 0) {
		return [
			`Refused: this "${toolName}" call sets ${suppliedRangeParams.map((name) => `\`${name}\``).join(" and ")},`,
			`but ${overriding.map((name) => `\`${name}\``).join(" and ")} defaults to true and overrides it.`,
			"The call would have returned everything rather than the requested range, and that full",
			"payload stays in context for the rest of the session.",
			`Set ${overriding.map((name) => `\`${name}\`: false`).join(", ")} to keep the range.`,
		].join("\n");
	}

	return undefined;
}

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

const MCP_SPILL_PREFIX = "codeify-mcp";

interface McpToolDetails {
	mode: string;
	server?: string;
	tool?: string;
	isError?: boolean;
	text: string;
	fullOutputPath?: string;
}

function result(text: string, details: Omit<McpToolDetails, "text">): AgentToolResult<McpToolDetails> {
	const capped = capOutputWithNotice(text, { tempFilePrefix: MCP_SPILL_PREFIX });
	return {
		content: [{ type: "text", text: capped.text }],
		details: { ...details, text: capped.text, fullOutputPath: capped.fullOutputPath },
	};
}

async function shrinkMcpImage(data: string, mimeType: string): Promise<{ data: string; mimeType: string } | null> {
	let bytes: Buffer;
	try {
		bytes = Buffer.from(data, "base64");
	} catch {
		return null;
	}
	if (bytes.length === 0) return null;
	const processed = await processImage(bytes, mimeType, {
		autoResizeImages: true,
		resizeOptions: { maxWidth: MCP_IMAGE_MAX_DIMENSION, maxHeight: MCP_IMAGE_MAX_DIMENSION },
	});
	if (!processed.ok) return null;
	// Re-encoding can inflate simple synthetic images. Only take the rewrite when it
	// actually costs fewer tokens than the original payload.
	if (processed.data.length >= data.length) return null;
	return { data: processed.data, mimeType: processed.mimeType };
}

async function mcpContentToBlocks(
	content: McpContentBlock[],
	resizeImages: boolean,
): Promise<(TextContent | ImageContent)[]> {
	const blocks: (TextContent | ImageContent)[] = [];
	for (const item of content) {
		if (item.type === "text") {
			blocks.push({ type: "text", text: typeof item.text === "string" ? item.text : JSON.stringify(item) });
		} else if (item.type === "image") {
			const data = typeof item.data === "string" ? item.data : "";
			const mimeType = typeof item.mimeType === "string" ? item.mimeType : "image/png";
			const shrunk = resizeImages && data ? await shrinkMcpImage(data, mimeType) : null;
			blocks.push({
				type: "image",
				data: shrunk?.data ?? data,
				mimeType: shrunk?.mimeType ?? mimeType,
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
		"",
		`Output is capped at ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If capped, the full output is written to a temp file and the path is included in the result; use the read tool on that path to see the rest.`,
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

export function createMcpToolDefinition(
	manager: McpManager,
	serverNames: string[],
	options?: McpToolOptions,
): AnyToolDefinition {
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
					const known = (await manager.listTools(params.server)).find((tool) => tool.name === params.tool);
					const ignoredRange = known
						? describeIgnoredRangeArgs(params.tool, parsedArgs, known.inputSchema)
						: undefined;
					if (ignoredRange) {
						return result(ignoredRange, {
							mode: "call",
							tool: params.tool,
							server: params.server ?? known?.server,
							isError: true,
						});
					}
					const callResult = await manager.callTool(params.tool, parsedArgs, params.server);
					const blocks = await mcpContentToBlocks(callResult.content, options?.autoResizeImages?.() ?? true);
					const rawText = blocks.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
					const capped = capOutputWithNotice(rawText, { tempFilePrefix: MCP_SPILL_PREFIX });
					// Replace the text blocks with a single capped block, keeping images intact
					// so attachments still reach the model.
					const cappedBlocks: (TextContent | ImageContent)[] = capped.truncation.truncated
						? [
								{ type: "text", text: capped.text },
								...blocks.filter((block): block is ImageContent => block.type === "image"),
							]
						: blocks;
					return {
						content: cappedBlocks,
						details: {
							mode: "call",
							tool: params.tool,
							server: params.server,
							isError: callResult.isError,
							text: capped.text,
							fullOutputPath: capped.fullOutputPath,
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
