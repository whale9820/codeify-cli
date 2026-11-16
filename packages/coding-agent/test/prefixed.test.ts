import { describe, expect, test, vi } from "vitest";
import { PrefixedComponent } from "../src/modes/interactive/components/prefixed.ts";

describe("PrefixedComponent", () => {
	test("reuses prefixed lines when children return unchanged content", () => {
		const child = { render: vi.fn(() => ["first", "second"]), invalidate: () => {} };
		const component = new PrefixedComponent(child, "> ", "  ");
		const first = component.render(40);
		expect(first).toEqual(["> first", "  second"]);
		expect(component.render(40)).toBe(first);
		expect(child.render).toHaveBeenCalledTimes(2);
		expect(child.render).toHaveBeenLastCalledWith(38);
	});

	test("refreshes cached output when child lines change in place", () => {
		const lines = ["first", "second"];
		const component = new PrefixedComponent({ render: () => lines, invalidate: () => {} }, "> ", "  ");
		const first = component.render(40);
		lines[1] = "updated";
		const updated = component.render(40);
		expect(first).toEqual(["> first", "  second"]);
		expect(updated).toEqual(["> first", "  updated"]);
		expect(component.render(40)).toBe(updated);
		lines.pop();
		expect(component.render(40)).toEqual(["> first"]);
		lines.length = 0;
		expect(component.render(40)).toEqual([]);
		lines.push("new content");
		expect(component.render(40)).toEqual(["> new content"]);
	});

	test("updates animated children on every render", () => {
		const child = { render: vi.fn(() => ["first"]).mockReturnValueOnce(["initial"]), invalidate: () => {} };
		const component = new PrefixedComponent(child, "> ", "  ");
		expect(component.render(40)).toEqual(["> initial"]);
		expect(component.render(40)).toEqual(["> first"]);
		expect(child.render).toHaveBeenCalledTimes(2);
	});

	test("rerenders after width changes using visible prefix widths", () => {
		const child = { render: vi.fn((width: number) => [`width ${width}`]), invalidate: () => {} };
		const component = new PrefixedComponent(child, "\x1b[32m> \x1b[0m", "   ");
		expect(component.render(40)).toEqual(["\x1b[32m> \x1b[0mwidth 37"]);
		expect(component.render(20)).toEqual(["\x1b[32m> \x1b[0mwidth 17"]);
		expect(component.render(1)).toEqual(["\x1b[32m> \x1b[0mwidth 1"]);
	});

	test("skips leading styled blank lines before adding the first prefix", () => {
		const lines = ["", "\x1b[32m  \x1b[0m", "first", "", "second"];
		const component = new PrefixedComponent({ render: () => lines, invalidate: () => {} }, "> ", "  ", true);
		const rendered = component.render(40);
		expect(rendered).toEqual(["> first", "  ", "  second"]);
		expect(component.render(40)).toBe(rendered);
		lines[1] = "updated";
		expect(component.render(40)).toEqual(["> updated", "  first", "  ", "  second"]);
	});

	test("clears cached lines and invalidates the child", () => {
		const child = { render: () => ["first"], invalidate: vi.fn() };
		const component = new PrefixedComponent(child, "> ", "  ");
		const first = component.render(40);
		expect(component.render(40)).toBe(first);
		component.invalidate();
		expect(child.invalidate).toHaveBeenCalledTimes(1);
		const refreshed = component.render(40);
		expect(refreshed).toEqual(first);
		expect(refreshed).not.toBe(first);
	});
});
