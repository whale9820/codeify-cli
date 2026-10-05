import { fauxAssistantMessage, fauxToolCall } from "codeify-ai";
import { expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import { createHarness } from "./harness.ts";

const io = vi.hoisted(() => ({
	output: [] as string[],
	onLine: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../src/core/output-guard.ts", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => io.output.push(line),
}));

vi.mock("../../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: (_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		io.onLine = onLine;
		return () => {};
	},
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

it("emits questions, exposes pending state, and resumes only for valid RPC answers", async () => {
	const harness = await createHarness();
	const signals = ["SIGTERM", "SIGHUP"] as const;
	const listeners = signals.map((signal) => process.listeners(signal));
	const stdinListeners = process.stdin.listeners("end");
	const runtime = { session: harness.session, setRebindSession: vi.fn() } as unknown as AgentSessionRuntime;
	try {
		void runRpcMode(runtime);
		await vi.waitFor(() => expect(io.onLine).toBeDefined());
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("request_user_input", { questions: [{ question: "What name?" }] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Answered."),
		]);
		io.onLine!(JSON.stringify({ type: "prompt", message: "ask me", id: "prompt" }));
		await vi.waitFor(() => expect(harness.session.getPendingUserInput()).toBeDefined());
		const request = harness.session.getPendingUserInput()!;
		expect(io.output.map((line) => JSON.parse(line))).toContainEqual({ type: "user_input_requested", request });
		io.onLine!(JSON.stringify({ type: "get_state", id: "state" }));
		io.onLine!(JSON.stringify({ type: "user_input_response", id: "bad", requestId: request.id, answers: [""] }));
		await vi.waitFor(() =>
			expect(io.output.map((line) => JSON.parse(line))).toContainEqual(
				expect.objectContaining({ id: "bad", success: false }),
			),
		);
		expect(io.output.map((line) => JSON.parse(line))).toContainEqual(
			expect.objectContaining({ id: "state", data: expect.objectContaining({ pendingUserInput: request }) }),
		);
		expect(harness.getPendingResponseCount()).toBe(1);
		io.onLine!(
			JSON.stringify({ type: "user_input_response", id: "answer", requestId: request.id, answers: ["my project"] }),
		);
		await vi.waitFor(() => expect(harness.eventsOfType("agent_settled")).toHaveLength(1));
		expect(harness.session.getLastAssistantText()).toBe("Answered.");
		expect(io.output.map((line) => JSON.parse(line))).toContainEqual({
			type: "response",
			id: "answer",
			command: "user_input_response",
			success: true,
		});
	} finally {
		harness.cleanup();
		for (const [index, signal] of signals.entries()) {
			for (const listener of process.listeners(signal)) {
				if (!listeners[index].includes(listener)) process.removeListener(signal, listener as () => void);
			}
		}
		for (const listener of process.stdin.listeners("end")) {
			if (!stdinListeners.includes(listener)) process.stdin.removeListener("end", listener as () => void);
		}
	}
});
