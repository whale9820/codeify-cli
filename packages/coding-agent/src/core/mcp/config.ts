import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface McpServerConfig {
	command: string;
	args: string[];
	env?: Record<string, string>;
	transport: string;
	lifecycle: string;
}

export interface McpConfig {
	mcpServers: Record<string, McpServerConfig>;
}

export function getMcpConfigPath(agentDir: string): string {
	return join(agentDir, "mcp.json");
}

export function loadMcpConfig(agentDir: string): { config: McpConfig; diagnostics: string[] } {
	const diagnostics: string[] = [];
	const path = getMcpConfigPath(agentDir);
	if (!existsSync(path)) {
		return { config: { mcpServers: {} }, diagnostics };
	}

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		diagnostics.push(`Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return { config: { mcpServers: {} }, diagnostics };
	}

	const servers = (raw as { mcpServers?: unknown })?.mcpServers;
	if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
		return { config: { mcpServers: {} }, diagnostics };
	}

	const mcpServers: Record<string, McpServerConfig> = {};
	for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
		const entry = value as {
			command?: unknown;
			args?: unknown;
			env?: unknown;
			transport?: unknown;
			lifecycle?: unknown;
		};
		if (!entry || typeof entry.command !== "string") {
			diagnostics.push(`MCP server "${name}" is missing a "command"; skipping.`);
			continue;
		}
		const transport = typeof entry.transport === "string" ? entry.transport : "stdio";
		if (transport !== "stdio") {
			diagnostics.push(`MCP server "${name}" uses unsupported transport "${transport}"; skipping.`);
			continue;
		}
		const env =
			entry.env && typeof entry.env === "object" && !Array.isArray(entry.env)
				? Object.fromEntries(Object.entries(entry.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
				: undefined;
		mcpServers[name] = {
			command: entry.command,
			args: Array.isArray(entry.args) ? entry.args.map((arg) => String(arg)) : [],
			env,
			transport,
			lifecycle: typeof entry.lifecycle === "string" ? entry.lifecycle : "lazy",
		};
	}

	return { config: { mcpServers }, diagnostics };
}
