import { randomFillSync } from "node:crypto";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { McpManager } from "../src/core/mcp/manager.ts";
import { createMcpToolDefinition, type McpToolOptions } from "../src/core/mcp/tool.ts";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
	const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(typeAndData));
	return Buffer.concat([length, typeAndData, crc]);
}

function crc32(buffer: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) {
			crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a noisy RGB PNG. Noise matters: a compressible pattern encodes so small that a
 * downscale can come out larger, which is not how real screen captures behave.
 */
function noisyPng(width: number, height: number): string {
	const rows: Buffer[] = [];
	for (let y = 0; y < height; y++) {
		const row = Buffer.alloc(1 + width * 3);
		randomFillSync(row, 1);
		rows.push(row);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const png = Buffer.concat([
		PNG_MAGIC,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
	return png.toString("base64");
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

async function callTool(content: unknown[], options?: McpToolOptions) {
	const definition = createMcpToolDefinition(stubManager(content), ["stub"], options);
	const result = await definition.execute("call-1", { tool: "screen_capture" }, undefined, undefined, {
		cwd: process.cwd(),
	});
	return result as { content: Array<{ type: string; data?: string; mimeType?: string }> };
}

function pngDimensions(base64Data: string): { width: number; height: number } | null {
	const bytes = Buffer.from(base64Data, "base64");
	if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) return null;
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("MCP tool result image downscaling", () => {
	it("downscales an oversized capture and shrinks its payload", async () => {
		// 1920x1052 is the viewport size Roblox Studio screen_capture returns.
		const capture = noisyPng(1920, 1052);
		const result = await callTool([{ type: "image", data: capture, mimeType: "image/png" }]);

		const image = result.content.find((block) => block.type === "image");
		const shrunk = image?.data as string;
		expect(shrunk).toBeDefined();
		expect(shrunk).not.toBe(capture);
		expect(shrunk.length).toBeLessThan(capture.length);

		const dimensions = pngDimensions(shrunk);
		if (dimensions) {
			expect(dimensions.width).toBeLessThanOrEqual(1024);
			expect(dimensions.height).toBeLessThanOrEqual(1024);
		}
	});

	it("leaves an already small image alone", async () => {
		const small = noisyPng(64, 64);
		const result = await callTool([{ type: "image", data: small, mimeType: "image/png" }]);

		const image = result.content.find((block) => block.type === "image");
		expect(image?.data).toBe(small);
	});

	it("passes images through untouched when auto resize is disabled", async () => {
		const capture = noisyPng(1920, 1052);
		const result = await callTool([{ type: "image", data: capture, mimeType: "image/png" }], {
			autoResizeImages: () => false,
		});

		const image = result.content.find((block) => block.type === "image");
		expect(image?.data).toBe(capture);
		expect(image?.mimeType).toBe("image/png");
	});

	it("keeps text blocks alongside images", async () => {
		const result = await callTool([
			{ type: "text", text: "captured" },
			{ type: "image", data: noisyPng(1920, 1052), mimeType: "image/png" },
		]);

		expect(result.content[0].type).toBe("text");
		expect(result.content.filter((block) => block.type === "image")).toHaveLength(1);
	});

	it("leaves an unreadable image payload in place rather than dropping it", async () => {
		const result = await callTool([{ type: "image", data: "not-a-real-image", mimeType: "image/png" }]);

		const image = result.content.find((block) => block.type === "image");
		expect(image?.data).toBe("not-a-real-image");
	});
});
