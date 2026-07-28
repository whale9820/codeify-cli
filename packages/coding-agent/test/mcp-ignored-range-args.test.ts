import { describe, expect, it, vi } from "vitest";
import type { McpManager } from "../src/core/mcp/manager.ts";
import { createMcpToolDefinition } from "../src/core/mcp/tool.ts";

// Mirrors the live Roblox Studio script_read schema: reads everything by default, and does
// not declare offset/limit.
const SCRIPT_READ_SCHEMA = {
	type: "object",
	properties: {
		target_file: { type: "string", description: "Dot-notation path of the script" },
		should_read_entire_file: {
			type: "boolean",
			description: "Whether to read the entire script. Defaults to true.",
		},
		start_line_one_indexed: { type: "integer", description: "Line to start at" },
		end_line_one_indexed_inclusive: { type: "integer", description: "Line to end at" },
	},
	required: ["target_file"],
};

function managerWith(callTool: () => Promise<{ content: unknown[]; isError: boolean }>) {
	const tools = [
		{ server: "Roblox Studio", name: "script_read", description: "Reads a script", inputSchema: SCRIPT_READ_SCHEMA },
		{
			server: "Roblox Studio",
			name: "get_console_output",
			description: "Logs",
			inputSchema: { type: "object", properties: {} },
		},
	];
	return {
		serverNames: ["Roblox Studio"],
		hasServer: () => true,
		isConnected: () => true,
		cachedTools: () => tools,
		listTools: async () => tools,
		refreshTools: async () => tools,
		callTool,
	} as unknown as McpManager;
}

async function call(args: Record<string, unknown>, toolName = "script_read") {
	const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "WHOLE FILE" }], isError: false }));
	const definition = createMcpToolDefinition(managerWith(callTool), ["Roblox Studio"]);
	const result = (await definition.execute(
		"call-1",
		{ tool: toolName, args: JSON.stringify(args) },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	)) as { content: Array<{ text?: string }>; details: { isError?: boolean } };
	return { result, callTool };
}

describe("MCP range-argument intent mismatch", () => {
	it("refuses offset/limit on a tool that does not declare them", async () => {
		const { result, callTool } = await call({ target_file: "game.X", offset: 690, limit: 30 });

		expect(callTool).not.toHaveBeenCalled();
		expect(result.details.isError).toBe(true);
		const text = result.content[0].text as string;
		expect(text).toContain("does not accept");
		expect(text).toContain("`offset`");
		expect(text).toContain("`limit`");
		// Points at the parameters that do work.
		expect(text).toContain("start_line_one_indexed");
		expect(text).toContain("should_read_entire_file");
	});

	it("refuses line bounds when the entire-file flag is left at its true default", async () => {
		const { result, callTool } = await call({
			target_file: "game.X",
			start_line_one_indexed: 1400,
			end_line_one_indexed_inclusive: 1440,
		});

		expect(callTool).not.toHaveBeenCalled();
		expect(result.details.isError).toBe(true);
		const text = result.content[0].text as string;
		expect(text).toContain("overrides it");
		expect(text).toContain("`should_read_entire_file`: false");
	});

	it("allows a correctly formed partial read", async () => {
		const { result, callTool } = await call({
			target_file: "game.X",
			should_read_entire_file: false,
			start_line_one_indexed: 1400,
			end_line_one_indexed_inclusive: 1440,
		});

		expect(callTool).toHaveBeenCalledOnce();
		expect(result.details.isError).toBeFalsy();
	});

	it("allows a deliberate whole-file read", async () => {
		const { result, callTool } = await call({ target_file: "game.X" });

		expect(callTool).toHaveBeenCalledOnce();
		expect(result.details.isError).toBeFalsy();
	});

	it("allows an explicit whole-file read that also carries bounds", async () => {
		const { callTool } = await call({ target_file: "game.X", should_read_entire_file: true });

		expect(callTool).toHaveBeenCalledOnce();
	});

	it("does not interfere with tools that take no range arguments", async () => {
		const { callTool } = await call({}, "get_console_output");

		expect(callTool).toHaveBeenCalledOnce();
	});

	it("passes through unknown tools rather than blocking them", async () => {
		const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }], isError: false }));
		const definition = createMcpToolDefinition(managerWith(callTool), ["Roblox Studio"]);
		await definition.execute(
			"call-2",
			{ tool: "not_in_listing", args: JSON.stringify({ offset: 1, limit: 2 }) },
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);

		expect(callTool).toHaveBeenCalledOnce();
	});
});
