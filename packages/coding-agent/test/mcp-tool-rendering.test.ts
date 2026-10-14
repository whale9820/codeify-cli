import { setKeybindings, type TUI } from "codeify-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
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
		setKeybindings(new KeybindingsManager());
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
		expect(rendered).toContain("MCP(Roblox Studio) create_script");
		expect(rendered).toContain('{"name":"Main","enabled":true}');
	});

	for (const args of [
		{ connect: "rea" },
		{ server: "rea" },
		{ search: "inspect", server: "rea" },
		{ describe: "inspect", server: "rea" },
		{ tool: "inspect", server: "rea" },
	]) {
		it(`caps large MCP results for ${JSON.stringify(args)}`, () => {
			const manager = new McpManager({ mcpServers: {} });
			const component = new ToolExecutionComponent(
				"mcp",
				"large-mcp",
				args,
				{},
				createMcpToolDefinition(manager, ["rea"]),
				createFakeTui(),
				process.cwd(),
			);
			const output = ["Connected (139 tools):", ...Array.from({ length: 139 }, (_, index) => `tool-${index}`)].join(
				"\n",
			);
			component.updateResult({ content: [{ type: "text", text: output }], isError: false });
			const collapsed = component.render(80).map(stripAnsi);
			expect(collapsed.length).toBeLessThanOrEqual(22);
			expect(collapsed.join("\n")).toContain("MCP(rea)");
			expect(collapsed.join("\n")).toContain("ctrl+o to expand");
			expect(collapsed.join("\n")).not.toContain("tool-138");
			component.setExpanded(true);
			expect(stripAnsi(component.render(80).join("\n"))).toContain("tool-138");
		});
	}
});
