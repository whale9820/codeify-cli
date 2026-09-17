import { describe, expect, it } from "vitest";
import {
	allToolNames,
	createAllToolDefinitions,
	createAllTools,
	createTool,
	createToolDefinition,
	createWebSearchTool,
	createWebSearchToolDefinition,
} from "../src/core/tools/index.ts";

describe("web_search tool", () => {
	it("registers web_search and websearch in allToolNames", () => {
		expect(allToolNames.has("web_search")).toBe(true);
		expect(allToolNames.has("websearch")).toBe(true);
	});

	it("creates web_search tool and definition directly", async () => {
		const def = createWebSearchToolDefinition("/test");
		expect(def.name).toBe("web_search");
		expect(def.description).toContain("Search the web");
		expect(def.parameters).toBeDefined();

		const result = await def.execute("call-1", { query: "test query" }, undefined, undefined, {} as any);
		expect(result.content[0].type).toBe("text");
		const textBlock = result.content[0];
		if (textBlock.type === "text") {
			expect(textBlock.text).toContain("server-side");
		}

		const tool = createWebSearchTool("/test");
		expect(tool.name).toBe("web_search");
	});

	it("creates web_search via createToolDefinition with case insensitivity", () => {
		const def1 = createToolDefinition("web_search", "/test");
		const def2 = createToolDefinition("websearch", "/test");
		const def3 = createToolDefinition("WebSearch", "/test");

		expect(def1.name).toBe("web_search");
		expect(def2.name).toBe("web_search");
		expect(def3.name).toBe("web_search");
	});

	it("creates web_search via createTool with case insensitivity", () => {
		const tool1 = createTool("web_search", "/test");
		const tool2 = createTool("websearch", "/test");
		const tool3 = createTool("WebSearch", "/test");

		expect(tool1.name).toBe("web_search");
		expect(tool2.name).toBe("web_search");
		expect(tool3.name).toBe("web_search");
	});

	it("includes web_search in createAllTools and createAllToolDefinitions", () => {
		const allDefs = createAllToolDefinitions("/test");
		const allToolsMap = createAllTools("/test");

		expect(allDefs.web_search).toBeDefined();
		expect(allDefs.websearch).toBeDefined();
		expect(allToolsMap.web_search).toBeDefined();
		expect(allToolsMap.websearch).toBeDefined();
	});
});
