import { fauxAssistantMessage } from "codeify-ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "../harness.ts";

const malformedJsonErrors = [
	"Expected ':' after property name in JSON at position 4058 (line 1 column 4059)",
	"Error: Unterminated string in JSON at position 2621 (line 1 column 2622)",
	"Expected double-quoted property name in JSON at position 21751 (line 1 column 21752)",
];
const networkUnstableMessage = "network unstable please try again";

describe("malformed JSON parse retry", () => {
	it.each(malformedJsonErrors)("recovers from %s", async (errorMessage) => {
		const harness = await createHarness({ settings: { retry: { enabled: true, baseDelayMs: 1 } } });
		try {
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage }),
				fauxAssistantMessage("recovered"),
			]);
			await harness.session.prompt("test");
			expect(harness.faux.state.callCount).toBe(2);
			expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: true, attempt: 1 }]);
		} finally {
			harness.cleanup();
		}
	});
	it.each(malformedJsonErrors)("caps retries at three for %s", async (malformedJsonError) => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 5, baseDelayMs: 1 } },
		});
		try {
			harness.setResponses(
				Array.from({ length: 4 }, () =>
					fauxAssistantMessage("", { stopReason: "error", errorMessage: malformedJsonError }),
				),
			);

			await harness.session.prompt("test");

			expect(harness.faux.state.callCount).toBe(4);
			expect(harness.eventsOfType("auto_retry_start")).toHaveLength(3);
			expect(harness.eventsOfType("auto_retry_end").map((event) => event.finalError)).toEqual([
				networkUnstableMessage,
			]);
			const lastMessage = harness.session.messages[harness.session.messages.length - 1];
			expect(lastMessage?.role).toBe("assistant");
			if (lastMessage?.role === "assistant") {
				expect(lastMessage.errorMessage).toBe(networkUnstableMessage);
				expect(lastMessage.diagnostics).toMatchObject([
					{ type: "malformed_json", error: { message: malformedJsonError } },
				]);
			}
		} finally {
			harness.cleanup();
		}
	});
});
