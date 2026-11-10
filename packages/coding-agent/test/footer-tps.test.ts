import { describe, expect, it } from "vitest";
import {
	estimateStreamTokens,
	FooterTpsTracker,
	formatTps,
	isFooterTpsSnapshot,
} from "../src/modes/interactive/components/footer-tps.ts";

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
	it("shows 0 for a new tracker", () => {
		const tracker = new FooterTpsTracker();
		expect(tracker.getLabel()).toBe("0.0 tps");
		expect(tracker.getSnapshot()).toEqual({ rate: 0, estimated: false });
	});

	it("keeps the previous value until 300ms after the first token", () => {
		const tracker = new FooterTpsTracker();
		tracker.start(0);
		expect(tracker.addChunk("abcd", 0)).toBe(false);
		expect(tracker.getLabel()).toBe("0.0 tps");
		expect(tracker.addChunk("efgh", 300)).toBe(false);
		expect(tracker.getLabel()).toBe("0.0 tps");
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

	it("keeps the last displayed value when generation lasted 50ms or less", () => {
		const tracker = new FooterTpsTracker();
		tracker.restore({ rate: 42, estimated: false });
		tracker.start(0);
		tracker.addChunk("abcd", 0);
		expect(tracker.finish(10, 50)).toBe(false);
		expect(tracker.getLabel()).toBe("42.0 tps");
	});

	it("keeps the last completed rate while the next stream starts", () => {
		const tracker = new FooterTpsTracker();
		tracker.start(0);
		tracker.addChunk("abcd", 301);
		tracker.finish(100, 1000);
		expect(tracker.getLabel()).toBe("100.0 tps");

		tracker.start(2000);
		expect(tracker.getLabel()).toBe("100.0 tps");
		tracker.addChunk("abcd", 2000);
		expect(tracker.getLabel()).toBe("100.0 tps");
		tracker.addChunk("efgh", 2301);
		expect(tracker.getLabel()).toBe(formatTps(2 / 0.301, true));
	});

	it("keeps the last displayed value on cancel", () => {
		const tracker = new FooterTpsTracker();
		tracker.start(0);
		tracker.addChunk("abcd", 301);
		tracker.finish(50, 1000);
		expect(tracker.getLabel()).toBe("50.0 tps");

		tracker.start(2000);
		tracker.addChunk("abcd", 2000);
		tracker.cancel();
		expect(tracker.getLabel()).toBe("50.0 tps");

		tracker.start(3000);
		tracker.addChunk("abcd", 3000);
		tracker.addChunk("efgh", 3301);
		tracker.cancel();
		expect(tracker.getLabel()).toBe(formatTps(2 / 0.301, true));
	});

	it("restores and resets persisted values", () => {
		const tracker = new FooterTpsTracker();
		tracker.restore({ rate: 77.25, estimated: true });
		expect(tracker.getLabel()).toBe("~77.3 tps");
		expect(tracker.getSnapshot()).toEqual({ rate: 77.25, estimated: true });
		tracker.reset();
		expect(tracker.getLabel()).toBe("0.0 tps");
	});
});

describe("isFooterTpsSnapshot", () => {
	it("validates persisted data", () => {
		expect(isFooterTpsSnapshot({ rate: 1, estimated: false })).toBe(true);
		expect(isFooterTpsSnapshot({ rate: -1, estimated: false })).toBe(false);
		expect(isFooterTpsSnapshot({ rate: "1", estimated: false })).toBe(false);
		expect(isFooterTpsSnapshot(undefined)).toBe(false);
	});
});
