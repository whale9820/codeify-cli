import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let directory: string;
let server: Server;
let baseUrl: string;
let child: ChildProcessWithoutNullStreams | undefined;
let exited: Promise<number | null> | undefined;
let stdout: string;
let stderr: string;
let pending: ServerResponse[];

beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "codeify-startup-cli-"));
	stdout = "";
	stderr = "";
	pending = [];
	server = createServer((request, response) => {
		if (request.url === "/v1/models") pending.push(response);
		else response.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test server address");
	baseUrl = `http://127.0.0.1:${address.port}/v1`;
	writeFileSync(join(directory, "auth.json"), JSON.stringify({ codeify: { type: "api_key", key: "test-key" } }));
	writeFileSync(
		join(directory, "settings.json"),
		JSON.stringify({ defaultProvider: "codeify", defaultModel: "cached-model" }),
	);
	writeFileSync(
		join(directory, "models-store.json"),
		JSON.stringify({
			codeify: {
				checkedAt: 0,
				models: [
					{
						id: "cached-model",
						name: "cached-model",
						provider: "codeify",
						api: "openai-responses",
						baseUrl,
						reasoning: false,
						input: ["text"],
						cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 16384,
					},
				],
			},
		}),
	);
});

afterEach(async () => {
	if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	await exited;
	child = undefined;
	exited = undefined;
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(directory, { recursive: true, force: true });
});

function launch(args: string[]) {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		CODEIFY_CODING_AGENT_DIR: directory,
		CODEIFY_BASE_URL: baseUrl,
		CODEIFY_API_KEY: "test-key",
	};
	delete env.CODEIFY_OFFLINE;
	delete env.CODEIFY_STARTUP_BENCHMARK;
	child = spawn(
		process.execPath,
		[
			resolve(__dirname, "../src/cli.ts"),
			"--no-session",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			...args,
		],
		{ cwd: directory, env, stdio: "pipe" },
	);
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	exited = new Promise((resolve, reject) => {
		child!.once("error", reject);
		child!.once("close", resolve);
	});
	return child;
}

function finishDiscovery() {
	for (const response of pending) {
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({ data: [{ id: "discovered-model" }] }));
	}
}

describe("CLI startup network boundaries", () => {
	it("answers RPC state requests before a slow catalog request completes", async () => {
		const process = launch(["--mode", "rpc"]);
		process.stdin.write(`${JSON.stringify({ type: "get_state", id: "startup" })}\n`);

		await vi.waitFor(() => expect(pending).toHaveLength(1), { timeout: 10_000 });
		await vi.waitFor(() => expect(stdout).toContain('"id":"startup"'), { timeout: 1000 });
		const response = stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.find((line) => line.id === "startup");
		expect(response).toMatchObject({ success: true, data: { model: { id: "cached-model" } } });
		expect(pending[0].writableEnded).toBe(false);

		finishDiscovery();
		process.stdin.end();
		await vi.waitFor(() => expect(process.exitCode, stderr).toBe(0));
	});

	it("waits for discovery when explicitly listing models", async () => {
		const process = launch(["--list-models"]);
		process.stdin.end();

		await vi.waitFor(() => expect(pending).toHaveLength(1), { timeout: 10_000 });
		expect(process.exitCode).toBeNull();
		expect(stdout).not.toContain("discovered-model");
		finishDiscovery();
		await vi.waitFor(() => expect(process.exitCode, stderr).toBe(0));
		expect(stdout).toContain("discovered-model");
		expect(pending).toHaveLength(1);
	});
});
