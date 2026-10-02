import { describe, expect, it } from "vitest";
import { createBrowserToolDefinition } from "../src/core/tools/browser.ts";
import { BrowserBridge, type BrowserBridgeResult } from "../src/core/tools/browser-bridge.ts";

class FakeBridge extends BrowserBridge {
	calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
	reply: BrowserBridgeResult | Error = { text: "ok" };

	override async request(cmd: string, args: Record<string, unknown>): Promise<BrowserBridgeResult> {
		this.calls.push({ cmd, args });
		if (this.reply instanceof Error) throw this.reply;
		return this.reply;
	}
}

async function run(
	bridge: FakeBridge,
	params: Parameters<ReturnType<typeof createBrowserToolDefinition>["execute"]>[1],
) {
	const definition = createBrowserToolDefinition("/work", bridge);
	return definition.execute("call-1", params, undefined, undefined, { cwd: "/work" });
}

describe("browser tool", () => {
	it("forwards the action and only defined params to the bridge", async () => {
		const bridge = new FakeBridge();
		await run(bridge, { action: "network", api_only: true, url_contains: "/api/", limit: undefined });
		expect(bridge.calls).toEqual([{ cmd: "network", args: { api_only: true, url_contains: "/api/" } }]);
	});

	it("resolves output paths against the working directory", async () => {
		const bridge = new FakeBridge();
		await run(bridge, { action: "export_network", path: "out/net.json" });
		expect(bridge.calls[0]?.args.path).toBe("/work/out/net.json");
	});

	it("returns bridge text as tool output", async () => {
		const bridge = new FakeBridge();
		bridge.reply = { text: "status: 200\nurl: https://example.com/" };
		const result = await run(bridge, { action: "goto", url: "https://example.com" });
		expect(result.content[0]).toEqual({ type: "text", text: "status: 200\nurl: https://example.com/" });
		expect(result.details?.action).toBe("goto");
	});

	it("caps very long output and records the spill file", async () => {
		const bridge = new FakeBridge();
		bridge.reply = { text: Array.from({ length: 2000 }, (_, i) => `line-${i}`).join("\n") };
		const result = await run(bridge, { action: "html" });
		const text = result.content[0];
		expect(text?.type === "text" && text.text.includes("Full output:")).toBe(true);
		expect(result.details?.truncated).toBe(true);
	});

	it("adds install guidance when the browser fails to open", async () => {
		const bridge = new FakeBridge();
		bridge.reply = new Error("camoufox is not importable");
		await expect(run(bridge, { action: "open" })).rejects.toThrow("python3 -m camoufox fetch");
	});
});
