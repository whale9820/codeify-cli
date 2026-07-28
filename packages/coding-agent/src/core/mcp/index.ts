import type { ToolDefinition } from "../tools/types.ts";
import { loadMcpConfig } from "./config.ts";
import { McpManager } from "./manager.ts";
import { createMcpToolDefinition, type McpToolOptions } from "./tool.ts";

export interface McpSetup {
	tools: ToolDefinition[];
	manager?: McpManager;
	diagnostics: string[];
}

const setupCache = new Map<string, McpSetup>();
const trackedManagers = new Set<McpManager>();
let exitHookInstalled = false;

function trackManager(manager: McpManager): void {
	trackedManagers.add(manager);
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.on("exit", () => {
		for (const tracked of trackedManagers) {
			void tracked.close();
		}
	});
}

export function setupMcp(agentDir: string, options?: McpToolOptions): McpSetup {
	const cached = setupCache.get(agentDir);
	if (cached) return cached;

	const { config, diagnostics } = loadMcpConfig(agentDir);
	const serverNames = Object.keys(config.mcpServers);
	if (serverNames.length === 0) {
		const empty: McpSetup = { tools: [], diagnostics };
		setupCache.set(agentDir, empty);
		return empty;
	}

	const manager = new McpManager(config);
	trackManager(manager);
	const setup: McpSetup = {
		tools: [createMcpToolDefinition(manager, serverNames, options)],
		manager,
		diagnostics,
	};
	setupCache.set(agentDir, setup);
	return setup;
}
