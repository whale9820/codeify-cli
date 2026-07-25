import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { VERSION } from "../../config.ts";
import type { McpConfig, McpServerConfig } from "./config.ts";

export interface McpToolInfo {
	server: string;
	name: string;
	description?: string;
	inputSchema?: unknown;
}

export interface McpCallResult {
	content: McpContentBlock[];
	isError: boolean;
}

export interface McpContentBlock {
	type: string;
	text?: unknown;
	data?: unknown;
	mimeType?: unknown;
	resource?: { uri?: string; text?: string; mimeType?: string };
	[key: string]: unknown;
}

interface ServerConnection {
	client: Client;
	transport: StdioClientTransport;
	tools: McpToolInfo[];
}

function inheritedEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") env[key] = value;
	}
	return env;
}

export class McpManager {
	private readonly config: McpConfig;
	private readonly connections = new Map<string, ServerConnection>();
	private readonly connecting = new Map<string, Promise<ServerConnection>>();
	private closed = false;

	constructor(config: McpConfig) {
		this.config = config;
	}

	get serverNames(): string[] {
		return Object.keys(this.config.mcpServers);
	}

	hasServer(name: string): boolean {
		return name in this.config.mcpServers;
	}

	isConnected(name: string): boolean {
		return this.connections.has(name);
	}

	cachedTools(name: string): McpToolInfo[] {
		return this.connections.get(name)?.tools ?? [];
	}

	async connect(name: string): Promise<ServerConnection> {
		const existing = this.connections.get(name);
		if (existing) return existing;
		const pending = this.connecting.get(name);
		if (pending) return pending;
		const serverConfig = this.config.mcpServers[name];
		if (!serverConfig) throw new Error(`Unknown MCP server "${name}".`);
		const promise = this.doConnect(name, serverConfig);
		this.connecting.set(name, promise);
		try {
			const connection = await promise;
			this.connections.set(name, connection);
			return connection;
		} finally {
			this.connecting.delete(name);
		}
	}

	private async doConnect(name: string, cfg: McpServerConfig): Promise<ServerConnection> {
		const env = cfg.env ? { ...inheritedEnv(), ...cfg.env } : inheritedEnv();
		const transport = new StdioClientTransport({
			command: cfg.command,
			args: cfg.args,
			env,
			stderr: "pipe",
		});
		let stderrTail = "";
		transport.stderr?.on("data", (chunk: Buffer | string) => {
			stderrTail = (stderrTail + String(chunk)).slice(-4000);
		});
		const client = new Client({ name: "codeify-cli", version: VERSION }, { capabilities: {} });
		try {
			await client.connect(transport);
		} catch (error) {
			try {
				await transport.close();
			} catch {}
			const detail = stderrTail.trim() ? `\nServer stderr:\n${stderrTail.trim()}` : "";
			throw new Error(
				`Failed to connect to MCP server "${name}": ${error instanceof Error ? error.message : String(error)}${detail}`,
			);
		}
		const tools = await this.fetchTools(name, client);
		return { client, transport, tools };
	}

	private async fetchTools(name: string, client: Client): Promise<McpToolInfo[]> {
		const tools: McpToolInfo[] = [];
		try {
			let cursor: string | undefined;
			do {
				const result = await client.listTools(cursor ? { cursor } : undefined);
				for (const tool of result.tools) {
					tools.push({
						server: name,
						name: tool.name,
						description: tool.description,
						inputSchema: tool.inputSchema,
					});
				}
				cursor = result.nextCursor;
			} while (cursor);
		} catch {}
		return tools;
	}

	async refreshTools(name: string): Promise<McpToolInfo[]> {
		const connection = await this.connect(name);
		connection.tools = await this.fetchTools(name, connection.client);
		return connection.tools;
	}

	async listTools(server?: string): Promise<McpToolInfo[]> {
		const names = server ? [server] : this.serverNames;
		const all: McpToolInfo[] = [];
		for (const name of names) {
			if (!this.hasServer(name)) continue;
			try {
				const connection = await this.connect(name);
				all.push(...connection.tools);
			} catch {}
		}
		return all;
	}

	private findConnectedTool(toolName: string, server?: string): string | undefined {
		for (const [serverName, connection] of this.connections) {
			if (server && serverName !== server) continue;
			if (connection.tools.some((tool) => tool.name === toolName)) return serverName;
		}
		return undefined;
	}

	async callTool(
		toolName: string,
		args: Record<string, unknown> | undefined,
		server?: string,
	): Promise<McpCallResult> {
		if (server && !this.hasServer(server)) {
			throw new Error(`Unknown MCP server "${server}".`);
		}
		let targetServer = server ?? this.findConnectedTool(toolName);
		if (!targetServer) {
			for (const name of this.serverNames) {
				try {
					const connection = await this.connect(name);
					if (connection.tools.some((tool) => tool.name === toolName)) {
						targetServer = name;
						break;
					}
				} catch {}
			}
		}
		if (!targetServer) {
			throw new Error(
				`Tool "${toolName}" was not found on any MCP server. Use connect or search to discover available tools.`,
			);
		}
		const connection = await this.connect(targetServer);
		const result = await connection.client.callTool({ name: toolName, arguments: args ?? {} });
		const content = Array.isArray(result.content) ? (result.content as McpContentBlock[]) : [];
		return { content, isError: result.isError === true };
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const connections = Array.from(this.connections.values());
		this.connections.clear();
		await Promise.allSettled(connections.map((connection) => connection.client.close()));
	}
}
