import { describe, expect, it } from "vitest";
import { getCodeifyUserAgent } from "../src/utils/codeify-user-agent.ts";

describe("getCodeifyUserAgent", () => {
	it("formats the Codeify user agent", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getCodeifyUserAgent("1.2.3");

		expect(userAgent).toBe(`codeify/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^codeify\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
