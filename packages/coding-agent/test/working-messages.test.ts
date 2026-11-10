import { describe, expect, it } from "vitest";
import { pickWorkingVerb, workingActivityKey } from "../src/modes/interactive/components/working-messages.ts";

describe("working messages", () => {
	it("picks plain activity verbs when the fun roll fails", () => {
		const random = () => 0.99;
		expect(["Editing", "Updating", "Modifying"]).toContain(
			pickWorkingVerb({ kind: "tool", toolName: "edit" }, undefined, random),
		);
		expect(["Writing", "Responding", "Composing", "Drafting"]).toContain(
			pickWorkingVerb({ kind: "writing" }, undefined, random),
		);
	});

	it("falls back to a generic pool for unknown tools", () => {
		expect(pickWorkingVerb({ kind: "tool", toolName: "custom_ext_tool" }, undefined, () => 0.99)).toBeTruthy();
	});

	it("avoids repeating the previous verb", () => {
		for (let i = 0; i < 50; i++) {
			expect(pickWorkingVerb({ kind: "thinking" }, "Thinking", () => 0.99 - i / 100)).not.toBe("Thinking");
		}
	});

	it("keys activities by kind and tool name", () => {
		expect(workingActivityKey({ kind: "tool", toolName: "bash" })).toBe("tool:bash");
		expect(workingActivityKey({ kind: "thinking" })).toBe("thinking");
	});
});
