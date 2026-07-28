import { describe, expect, it, vi } from "vitest";
import { type ContextUsageSnapshot, createContextUsageToolDefinition } from "../src/core/tools/context-usage.ts";

function snapshot(overrides?: Partial<ContextUsageSnapshot>): ContextUsageSnapshot {
	return {
		tokens: 420_000,
		contextWindow: 1_000_000,
		percent: 42,
		turns: 240,
		compacted: false,
		costUsd: 61.5,
		...overrides,
	};
}

async function run(
	params: { request_compaction?: boolean },
	snap: ContextUsageSnapshot | undefined,
	requestCompaction = vi.fn(),
) {
	const definition = createContextUsageToolDefinition({
		getSnapshot: () => snap,
		requestCompaction,
	});
	const result = await definition.execute("call-1", params, undefined, undefined, { cwd: process.cwd() });
	const text = result.content.find((block) => block.type === "text");
	return { text: text?.type === "text" ? text.text : "", details: result.details, requestCompaction };
}

describe("context_usage tool", () => {
	it("reports window usage, turn count, and session cost", async () => {
		const { text } = await run({}, snapshot());

		expect(text).toContain("420k of 1.00M");
		expect(text).toContain("42.0%");
		expect(text).toContain("240");
		expect(text).toContain("$61.50");
	});

	it("states the per-turn resend cost so the model can reason about spend", async () => {
		const { text } = await run({}, snapshot());

		expect(text).toContain("re-sends about 420k tokens");
	});

	it("escalates its advice past half the window", async () => {
		const { text } = await run({}, snapshot({ tokens: 700_000, percent: 70 }));

		expect(text).toContain("past half the window");
	});

	it("does not compact on its own; it only records a request for the user", async () => {
		const requestCompaction = vi.fn();
		const { text, details } = await run({ request_compaction: true }, snapshot(), requestCompaction);

		expect(requestCompaction).toHaveBeenCalledOnce();
		expect(details.compactionRequested).toBe(true);
		// The model must not assume the compaction happened.
		expect(text).toContain("Do not assume it happened");
	});

	it("does not request compaction unless asked", async () => {
		const requestCompaction = vi.fn();
		await run({}, snapshot(), requestCompaction);

		expect(requestCompaction).not.toHaveBeenCalled();
	});

	it("reports unknown context size without inventing a number", async () => {
		const { text } = await run({}, snapshot({ tokens: null, percent: null }));

		expect(text).toContain("unknown");
		expect(text).not.toContain("NaN");
	});

	it("handles having no model selected", async () => {
		const { text } = await run({}, undefined);

		expect(text).toContain("unavailable");
	});

	it("marks a branch that was already compacted", async () => {
		const { text } = await run({}, snapshot({ compacted: true }));

		expect(text).toContain("already compacted");
	});
});
