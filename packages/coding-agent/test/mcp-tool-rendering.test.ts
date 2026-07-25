import type { TUI } from "codeify-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { McpManager } from "../src/core/mcp/manager.ts";
import { createMcpToolDefinition } from "../src/core/mcp/tool.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

describe("MCP tool rendering", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("shows the MCP server, tool, and argument context", () => {
		const manager = new McpManager({
			mcpServers: {
				"Roblox Studio": {
					command: "unused",
					args: [],
					transport: "stdio",
					lifecycle: "lazy",
				},
			},
		});
		const definition = createMcpToolDefinition(manager, manager.serverNames);
		const component = new ToolExecutionComponent(
			"mcp",
			"mcp-call-1",
			{
				server: "Roblox Studio",
				tool: "create_script",
				args: '{"name":"Main","enabled":true}',
			},
			{},
			definition,
			createFakeTui(),
			process.cwd(),
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("mcp call Roblox Studio / create_script");
		expect(rendered).toContain('{"name":"Main","enabled":true}');
	});
});
