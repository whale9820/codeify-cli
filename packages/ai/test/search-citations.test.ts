import { describe, expect, it } from "vitest";
import { buildCitationSources, renderInlineCitations } from "../src/utils/search-citations.ts";

const CITE = (refs: string) => `\uE200cite\uE202${refs}\uE201`;

describe("search citation markers", () => {
	it("renders a grouped cite marker as domain links", () => {
		const sources = new Map([
			["turn4search9", { url: "https://www.apnews.com/picasso" }],
			["turn4search10", { url: "https://www.bbc.com/raffle" }],
		]);
		const text = `A raffle won a Picasso. ${CITE("turn4search9\uE202turn4search10")}`;
		expect(renderInlineCitations(text, sources)).toBe(
			"A raffle won a Picasso. ([apnews.com](https://www.apnews.com/picasso), [bbc.com](https://www.bbc.com/raffle))",
		);
	});

	it("resolves a later turn from the earlier search's rendered citations", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "serverToolUse", id: "ws_1", name: "web_search", input: { query: "eiffel" } },
					{
						type: "text",
						text: "Opened in 1889. ([toureiffel.paris](https://www.toureiffel.paris/a)) ([toureiffel.paris](https://www.toureiffel.paris/b))",
					},
				],
			},
			{
				role: "assistant",
				content: [{ type: "text", text: `Opened in 1889. ${CITE("turn0search0\uE202turn0search1")}` }],
			},
		];
		const sources = buildCitationSources(messages);
		expect(renderInlineCitations(messages[1]?.content[0]?.text ?? "", sources)).toBe(
			"Opened in 1889. ([toureiffel.paris](https://www.toureiffel.paris/a), [toureiffel.paris](https://www.toureiffel.paris/b))",
		);
	});

	it("maps source lists onto the search turn index", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "serverToolUse", id: "ws_0", name: "web_search", input: { query: "one" } },
					{ type: "serverToolUse", id: "ws_1", name: "web_search", input: { query: "two" } },
				],
			},
			{
				role: "assistant",
				content: [
					{ type: "serverToolUse", id: "ws_2", name: "web_search", input: { query: "three" } },
					{
						type: "serverToolResult",
						toolUseId: "ws_2",
						content: [
							{ type: "url", url: "https://example.com/0" },
							{ type: "url", url: "https://example.com/1" },
						],
					},
				],
			},
		];
		const sources = buildCitationSources(messages);
		expect(sources.get("turn2search1")).toEqual({ url: "https://example.com/1" });
		expect(renderInlineCitations(`See ${CITE("turn2search1")}`, sources)).toBe(
			"See ([example.com](https://example.com/1))",
		);
	});

	it("prefers url citation annotations that cover the marker", () => {
		const marker = CITE("turn0search0");
		const text = `Fact. ${marker}`;
		const start = text.indexOf(marker);
		expect(
			renderInlineCitations(text, new Map(), [
				{
					type: "url_citation",
					url: "https://www.nytimes.com/story",
					title: "Story",
					startIndex: start,
					endIndex: start + marker.length,
				},
			]),
		).toBe("Fact. ([nytimes.com](https://www.nytimes.com/story))");
	});

	it("keeps hidden-control prose and drops an unfinished marker", () => {
		const text = "\uE203Visible sentence.\uE204 Still here. \uE200cite\uE202turn0sea";
		expect(renderInlineCitations(text)).toBe("Visible sentence. Still here. ");
	});

	it("leaves markers inside code fences untouched", () => {
		const text = `Before\n\`\`\`\n${CITE("turn0search0")}\n\`\`\`\nAfter ${CITE("turn0search0")}`;
		const sources = new Map([["turn0search0", { url: "https://example.com" }]]);
		expect(renderInlineCitations(text, sources)).toBe(
			`Before\n\`\`\`\n${CITE("turn0search0")}\n\`\`\`\nAfter ([example.com](https://example.com))`,
		);
	});

	it("drops a cite marker that has no source", () => {
		expect(renderInlineCitations(`Done. ${CITE("turn4search9\uE202turn4search10")}`)).toBe("Done. ");
	});
});
