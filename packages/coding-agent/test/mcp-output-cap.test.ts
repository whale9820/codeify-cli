import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { McpManager } from "../src/core/mcp/manager.ts";
import { createMcpToolDefinition } from "../src/core/mcp/tool.ts";
import { DEFAULT_MAX_LINES } from "../src/core/tools/truncate.ts";

interface McpDetails {
	text: string;
	fullOutputPath?: string;
}

function hugeText(lines: number): string {
	return Array.from({ length: lines }, (_, index) => `mcp line ${index + 1} ${"d".repeat(40)}`).join("\n");
}

function stubManager(content: unknown[]): McpManager {
	return {
		serverNames: ["stub"],
		hasServer: () => true,
		isConnected: () => true,
		cachedTools: () => [],
		listTools: async () => [],
		refreshTools: async () => [],
		callTool: async () => ({ content, isError: false }),
	} as unknown as McpManager;
}

async function callStubTool(content: unknown[]) {
	const definition = createMcpToolDefinition(stubManager(content), ["stub"]);
	const result = await definition.execute("call-1", { tool: "noisy_tool" }, undefined, undefined, {
		cwd: process.cwd(),
	});
	return result as { content: Array<{ type: string; text?: string }>; details: McpDetails };
}

describe("MCP output capping", () => {
	it("caps a huge MCP tool result and spills the full text to a temp file", async () => {
		const payload = hugeText(6000);
		const result = await callStubTool([{ type: "text", text: payload }]);

		const returnedText = result.content[0].text as string;
		expect(returnedText.length).toBeLessThan(payload.length);
		expect(returnedText).toContain("Full output:");
		expect(result.details.fullOutputPath).toBeDefined();
		expect(readFileSync(result.details.fullOutputPath as string, "utf-8")).toContain("mcp line 6000 ");
	});

	it("leaves small MCP results untouched", async () => {
		const result = await callStubTool([{ type: "text", text: "all good" }]);

		expect(result.content[0].text).toBe("all good");
		expect(result.details.fullOutputPath).toBeUndefined();
	});

	it("preserves image blocks when the text portion is capped", async () => {
		const result = await callStubTool([
			{ type: "text", text: hugeText(6000) },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		]);

		const images = result.content.filter((block) => block.type === "image");
		expect(images).toHaveLength(1);
		expect(result.content[0].type).toBe("text");
	});

	it("caps oversized listing output from non-call modes", async () => {
		const manager = {
			serverNames: ["stub"],
			hasServer: () => true,
			isConnected: () => true,
			cachedTools: () => [],
			listTools: async () => [],
			refreshTools: async () =>
				Array.from({ length: DEFAULT_MAX_LINES + 200 }, (_, index) => ({
					name: `tool_${index}`,
					description: "d".repeat(60),
					server: "stub",
				})),
		} as unknown as McpManager;

		const definition = createMcpToolDefinition(manager, ["stub"]);
		const result = (await definition.execute("call-2", { connect: "stub" }, undefined, undefined, {
			cwd: process.cwd(),
		})) as {
			content: Array<{ text?: string }>;
			details: McpDetails;
		};

		expect(result.content[0].text).toContain("Full output:");
		expect(result.details.fullOutputPath).toBeDefined();
	});
});
