import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

beforeEach(() => {
	vi.stubEnv("CODEIFY_OFFLINE", undefined);
	vi.stubEnv("CODEIFY_API_KEY", "unused-codeify-test-key");
	vi.stubEnv("OPENAI_API_KEY", "unused-openai-test-key");
	vi.stubEnv("ANTHROPIC_API_KEY", "unused-anthropic-test-key");
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is not permitted in the faux harness"));
});

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("faux harness isolation", () => {
	it("refreshes only faux models even when real provider environment keys are present", async () => {
		const harness = await createHarness({ models: [{ id: "faux-one" }, { id: "faux-two" }] });
		harnesses.push(harness);
		const runtime = harness.session.modelRuntime;

		expect(runtime.getProviders().map((provider) => provider.id)).toEqual([harness.getModel().provider]);
		expect(runtime.getAvailableSnapshot().map((model) => model.id)).toEqual(["faux-one", "faux-two"]);

		const result = await runtime.refresh({ allowNetwork: true, force: true });

		expect(result.aborted).toBe(false);
		expect(result.errors.size).toBe(0);
		expect((await runtime.getAvailable()).map((model) => model.id)).toEqual(["faux-one", "faux-two"]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("does not expose ambient providers when configured auth is disabled", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const runtime = harness.session.modelRuntime;

		const result = await runtime.refresh({ allowNetwork: true, force: true });

		expect(result.errors.size).toBe(0);
		expect(runtime.getProviders()).toEqual([]);
		expect(await runtime.getAvailable()).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
	});
});
