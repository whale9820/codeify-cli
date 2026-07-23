import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPiExperimental = process.env.CODEIFY_EXPERIMENTAL;

	afterEach(() => {
		if (originalPiExperimental === undefined) {
			delete process.env.CODEIFY_EXPERIMENTAL;
		} else {
			process.env.CODEIFY_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when CODEIFY_EXPERIMENTAL is unset", () => {
		delete process.env.CODEIFY_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when CODEIFY_EXPERIMENTAL is empty", () => {
		process.env.CODEIFY_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when CODEIFY_EXPERIMENTAL is set to 1", () => {
		process.env.CODEIFY_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when CODEIFY_EXPERIMENTAL is set to 0", () => {
		process.env.CODEIFY_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when CODEIFY_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.CODEIFY_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
