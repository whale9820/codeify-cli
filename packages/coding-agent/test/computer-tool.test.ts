import { describe, expect, it, vi } from "vitest";
import {
	type ComputerOperations,
	type ComputerSession,
	createComputerToolController,
} from "../src/core/tools/computer.ts";

describe("computer tool", () => {
	it("runs batched actions in one isolated policy-scoped session", async () => {
		const run = vi
			.fn<ComputerSession["run"]>()
			.mockResolvedValueOnce({
				url: "https://example.com/",
				title: "Example",
				data: "cG5n",
				mimeType: "image/png",
				closed: false,
			})
			.mockResolvedValueOnce({
				url: "https://example.com/about",
				title: "About",
				data: "cG5nMg==",
				mimeType: "image/png",
				closed: false,
			});
		const close = vi.fn(async () => {});
		const operations: ComputerOperations = {
			createSession: vi.fn(async (policy) => {
				expect(policy).toEqual({ allowedDomains: ["example.com"], allowNetworkWrites: false });
				return { run, close };
			}),
		};
		const controller = createComputerToolController({
			policy: { allowedDomains: ["example.com"], allowNetworkWrites: false },
			operations,
		});

		const first = await controller.definition.execute(
			"first",
			{ actions: [{ type: "open", url: "https://example.com" }, { type: "screenshot" }] },
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);
		const second = await controller.definition.execute(
			"second",
			{ actions: [{ type: "click", x: 40, y: 80 }] },
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);

		expect(operations.createSession).toHaveBeenCalledOnce();
		expect(run).toHaveBeenCalledTimes(2);
		expect(first.content).toEqual([
			{ type: "text", text: "Example\nhttps://example.com/" },
			{ type: "image", data: "cG5n", mimeType: "image/png" },
		]);
		expect(second.details).toMatchObject({ actionCount: 1, actions: ["click"], title: "About" });

		await controller.dispose();
		expect(close).toHaveBeenCalledOnce();
	});

	it("keeps credentials and unrestricted browsing out of the model-visible schema", () => {
		const controller = createComputerToolController({
			policy: { allowedDomains: ["example.com"] },
			operations: {
				createSession: async () => ({
					run: async () => ({
						url: "about:blank",
						title: "Blank",
						data: "",
						mimeType: "image/png",
						closed: false,
					}),
					close: async () => {},
				}),
			},
		});
		const serialized = JSON.stringify(controller.definition.parameters);

		expect(serialized).not.toContain("apiKey");
		expect(serialized).not.toContain("allowedDomains");
		expect(controller.definition.description).toContain("isolated Chromium browser");
		expect(controller.definition.promptGuidelines?.join(" ")).toContain("untrusted");
	});
});
