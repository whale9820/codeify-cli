import { describe, expect, it } from "vitest";
import { estimateStreamTokens, FooterTpsTracker, formatTps } from "../src/modes/interactive/components/footer-tps.ts";

describe("estimateStreamTokens", () => {
	it("counts about one token per four ASCII characters", () => {
		expect(estimateStreamTokens("abcd")).toBe(1);
		expect(estimateStreamTokens("abcdefgh")).toBe(2);
	});

	it("counts one token per CJK character", () => {
		expect(estimateStreamTokens("你好")).toBe(2);
		expect(estimateStreamTokens("日本語")).toBe(3);
		expect(estimateStreamTokens("한글")).toBe(2);
	});

	it("mixes CJK and ASCII estimates", () => {
		expect(estimateStreamTokens("ab你好")).toBe(2.5);
	});
});

describe("formatTps", () => {
	it("prefixes estimates with a tilde", () => {
		expect(formatTps(42.34, true)).toBe("~42.3 tps");
		expect(formatTps(113.5, false)).toBe("113.5 tps");
	});
});

describe("FooterTpsTracker", () => {
	it("hides the live rate until 300ms after the first token", () => {
		const tracker = new FooterTpsTracker();
		tracker.start(0);
		expect(tracker.addChunk("abcd", 0)).toBe(false);
		expect(tracker.getLabel()).toBeUndefined();
		expect(tracker.addChunk("efgh", 300)).toBe(false);
		expect(tracker.getLabel()).toBeUndefined();
		expect(tracker.addChunk("ijkl", 301)).toBe(true);
		expect(tracker.getLabel()).toBe(formatTps(3 / 0.301, true));
	});

	it("throttles live updates to 500ms after the last draw", () => {
		const tracker = new FooterTpsTracker();
		tracker.start(0);
		expect(tracker.addChunk("abcd", 0)).toBe(false);
		expect(tracker.addChunk("efgh", 301)).toBe(true);
		expect(tracker.getLabel()).toBe(formatTps(2 / 0.301, true));
		expect(tracker.addChunk("ijkl", 800)).toBe(false);
		expect(tracker.getLabel()).toBe(formatTps(2 / 0.301, true));
		expect(tracker.addChunk("mnop", 802)).toBe(true);
		expect(tracker.getLabel()).toBe(formatTps(4 / 0.802, true));
	});

	it("switches to the exact output-token rate on stop", () => {
		const tracker = new FooterTpsTracker();
		tracker.start(0);
		tracker.addChunk("a".repeat(400), 0);
		tracker.addChunk("b".repeat(4), 301);
		expect(tracker.getLabel()).toMatch(/^~/);

		expect(tracker.finish(227, 2000)).toBe(true);
		expect(tracker.getLabel()).toBe("113.5 tps");
	});

	it("omits the exact rate when generation lasted 50ms or less", () => {
		const tracker = new FooterTpsTracker();
		tracker.start(0);
		tracker.addChunk("abcd", 0);
		expect(tracker.finish(10, 50)).toBe(false);
		expect(tracker.getLabel()).toBeUndefined();
	});

	it("keeps the last completed rate until the next stream starts", () => {
		const tracker = new FooterTpsTracker();
		tracker.start(0);
		tracker.addChunk("abcd", 301);
		tracker.finish(100, 1000);
		expect(tracker.getLabel()).toBe("100.0 tps");

		tracker.start(2000);
		expect(tracker.getLabel()).toBeUndefined();
		tracker.addChunk("abcd", 2000);
		expect(tracker.getLabel()).toBeUndefined();
		tracker.addChunk("efgh", 2301);
		expect(tracker.getLabel()).toBe(formatTps(2 / 0.301, true));
	});

	it("cancels a live estimate without changing the previous completed rate", () => {
		const tracker = new FooterTpsTracker();
		tracker.start(0);
		tracker.addChunk("abcd", 301);
		tracker.finish(50, 1000);
		expect(tracker.getLabel()).toBe("50.0 tps");

		tracker.start(2000);
		tracker.addChunk("abcd", 2301);
		tracker.cancel();
		expect(tracker.getLabel()).toBe("50.0 tps");
	});
});
