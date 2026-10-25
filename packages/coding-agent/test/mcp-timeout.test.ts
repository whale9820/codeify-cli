import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadMcpConfig, type McpServerConfig } from "../src/core/mcp/config.ts";
import { McpManager } from "../src/core/mcp/manager.ts";
import { createMcpToolDefinition } from "../src/core/mcp/tool.ts";

const serverConfig: McpServerConfig = { command: "unused", args: [], transport: "stdio", lifecycle: "lazy" };

describe("MCP tool timeouts", () => {
	let client: Client;
	let server: Server;
	let manager: McpManager;
	let complete: (() => void) | undefined;
	let sendProgress: (() => Promise<void>) | undefined;
	let cancelled: boolean;

	beforeEach(async () => {
		vi.useFakeTimers();
		cancelled = false;
		complete = undefined;
		sendProgress = undefined;
		client = new Client({ name: "test-client", version: "1" });
		server = new Server({ name: "test-server", version: "1" }, { capabilities: { tools: {} } });
		server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
			extra.signal.addEventListener("abort", () => {
				cancelled = true;
				complete?.();
			});
			sendProgress = () =>
				extra.sendNotification({
					method: "notifications/progress",
					params: { progressToken: request.params._meta!.progressToken!, progress: 1 },
				});
			await new Promise<void>((resolve) => {
				complete = resolve;
			});
			return { content: [{ type: "text", text: "finished" }] };
		});
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		manager = new McpManager({ mcpServers: { slow: { ...serverConfig } } });
		vi.spyOn(manager, "connect").mockResolvedValue({
			client,
			transport: new StdioClientTransport({ command: "unused" }),
			tools: [],
		});
		vi.spyOn(manager, "listTools").mockResolvedValue([]);
	});

	afterEach(async () => {
		complete?.();
		await client.close();
		await server.close();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	test("allows a silent tool to finish after more than two minutes", async () => {
		const pending = manager.callTool("slow_tool", {}, "slow");
		await vi.advanceTimersByTimeAsync(125_000);
		expect(cancelled).toBe(false);
		complete!();
		await expect(pending).resolves.toEqual({ content: [{ type: "text", text: "finished" }], isError: false });
	});

	test("extends the timeout when the server reports progress", async () => {
		const pending = manager.callTool("slow_tool", {}, "slow");
		await vi.advanceTimersByTimeAsync(590_000);
		await sendProgress!();
		await vi.advanceTimersByTimeAsync(590_000);
		expect(cancelled).toBe(false);
		complete!();
		await expect(pending).resolves.toMatchObject({ isError: false });
	});

	test("honors a per-server timeout", async () => {
		const customManager = new McpManager({ mcpServers: { slow: { ...serverConfig, timeoutMs: 180_000 } } });
		vi.spyOn(customManager, "connect").mockImplementation((name) => manager.connect(name));
		const pending = customManager.callTool("slow_tool", {}, "slow");
		const rejected = expect(pending).rejects.toThrow(/timed out/i);
		await vi.advanceTimersByTimeAsync(180_001);
		await rejected;
		expect(cancelled).toBe(true);
	});

	test("forwards turn cancellation through the tool gateway", async () => {
		const controller = new AbortController();
		const definition = createMcpToolDefinition(manager, ["slow"]);
		const pending = definition.execute("call", { tool: "slow_tool", server: "slow" }, controller.signal, undefined, {
			cwd: process.cwd(),
		});
		await vi.advanceTimersByTimeAsync(125_000);
		controller.abort();
		await pending;
		expect(cancelled).toBe(true);
	});
});

test.each([180_000, -1, 0, "180000", 1.5, 2_147_483_648])("validates MCP timeoutMs %s", (timeoutMs) => {
	const dir = mkdtempSync(join(tmpdir(), "codeify-mcp-timeout-"));
	try {
		writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { slow: { command: "unused", timeoutMs } } }));
		const loaded = loadMcpConfig(dir);
		expect(loaded.config.mcpServers.slow.timeoutMs).toBe(timeoutMs === 180_000 ? timeoutMs : undefined);
		expect(loaded.diagnostics).toHaveLength(timeoutMs === 180_000 ? 0 : 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
