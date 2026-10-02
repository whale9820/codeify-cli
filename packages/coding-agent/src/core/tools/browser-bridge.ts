import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { BROWSER_BRIDGE_SCRIPT } from "./browser-bridge-script.ts";

export interface BrowserBridgeResult {
	text: string;
	file?: string;
}

interface PendingRequest {
	resolve: (result: BrowserBridgeResult) => void;
	reject: (error: Error) => void;
}

interface BridgeMessage {
	event?: string;
	id?: number;
	ok?: boolean;
	result?: BrowserBridgeResult;
	error?: string;
}

interface BridgeProcess {
	child: ChildProcessWithoutNullStreams;
	pending: Map<number, PendingRequest>;
	stderrTail: string;
}

const INSTALL_HINT =
	'Install it with: pip3 install -U "camoufox[geoip]" && python3 -m camoufox fetch (or set CODEIFY_BROWSER_PYTHON to a python that has camoufox).';

function pythonCandidates(): string[] {
	const configured = process.env.CODEIFY_BROWSER_PYTHON?.trim();
	if (configured) return [configured];
	return process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
}

function appendTail(current: string, chunk: string): string {
	const combined = current + chunk;
	return combined.length > 4000 ? combined.slice(combined.length - 4000) : combined;
}

export class BrowserBridge {
	private bridge: BridgeProcess | undefined;
	private starting: Promise<BridgeProcess> | undefined;
	private nextId = 1;

	async request(
		cmd: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		timeoutMs = 180_000,
	): Promise<BrowserBridgeResult> {
		if (signal?.aborted) throw new Error("Operation aborted");
		const bridge = await this.ensureStarted();
		const id = this.nextId++;

		return new Promise<BrowserBridgeResult>((resolve, reject) => {
			let settled = false;
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				bridge.pending.delete(id);
			};
			const settle = (action: () => void) => {
				if (settled) return;
				settled = true;
				cleanup();
				action();
			};
			const onAbort = () => settle(() => reject(new Error("Operation aborted")));
			const timer = setTimeout(
				() => settle(() => reject(new Error(`Browser command ${cmd} timed out after ${timeoutMs / 1000}s`))),
				timeoutMs,
			);

			signal?.addEventListener("abort", onAbort, { once: true });
			bridge.pending.set(id, {
				resolve: (result) => settle(() => resolve(result)),
				reject: (error) => settle(() => reject(error)),
			});
			bridge.child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`, (error) => {
				if (error) settle(() => reject(new Error(`Browser bridge write failed: ${error.message}`)));
			});
		});
	}

	isRunning(): boolean {
		return this.bridge !== undefined;
	}

	dispose(): void {
		const bridge = this.bridge;
		this.bridge = undefined;
		this.starting = undefined;
		if (!bridge) return;
		try {
			bridge.child.stdin.end();
		} catch {
			bridge.child.kill();
		}
		const killTimer = setTimeout(() => bridge.child.kill("SIGKILL"), 5000);
		killTimer.unref();
		bridge.child.once("exit", () => clearTimeout(killTimer));
	}

	private ensureStarted(): Promise<BridgeProcess> {
		if (this.bridge) return Promise.resolve(this.bridge);
		if (!this.starting) {
			this.starting = this.start().then(
				(bridge) => {
					this.bridge = bridge;
					this.starting = undefined;
					return bridge;
				},
				(error: unknown) => {
					this.starting = undefined;
					throw error;
				},
			);
		}
		return this.starting;
	}

	private async start(): Promise<BridgeProcess> {
		const failures: string[] = [];
		for (const python of pythonCandidates()) {
			try {
				return await this.spawnBridge(python);
			} catch (error) {
				failures.push(`${python}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		throw new Error(`Could not start the Camoufox browser bridge.\n${failures.join("\n")}\n${INSTALL_HINT}`);
	}

	private spawnBridge(python: string): Promise<BridgeProcess> {
		return new Promise<BridgeProcess>((resolve, reject) => {
			const child = spawn(python, ["-u", "-c", BROWSER_BRIDGE_SCRIPT], {
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
				windowsHide: true,
			});
			const bridge: BridgeProcess = { child, pending: new Map(), stderrTail: "" };
			let ready = false;

			child.stderr.on("data", (chunk: Buffer) => {
				bridge.stderrTail = appendTail(bridge.stderrTail, chunk.toString("utf-8"));
			});

			const lines = createInterface({ input: child.stdout });
			lines.on("line", (line) => {
				let message: BridgeMessage;
				try {
					message = JSON.parse(line) as BridgeMessage;
				} catch {
					return;
				}
				if (message.event === "ready") {
					if (message.error) {
						reject(new Error(message.error));
						child.kill();
						return;
					}
					ready = true;
					resolve(bridge);
					return;
				}
				if (message.id === undefined) return;
				const pending = bridge.pending.get(message.id);
				if (!pending) return;
				if (message.ok && message.result) {
					pending.resolve(message.result);
				} else {
					pending.reject(new Error(message.error ?? "Browser command failed"));
				}
			});

			child.once("error", (error) => {
				if (!ready) reject(error);
			});

			child.once("exit", (code) => {
				lines.close();
				const detail = bridge.stderrTail.trim();
				const failure = new Error(
					`Browser bridge exited${code === null ? "" : ` with code ${code}`}${detail ? `:\n${detail}` : ""}`,
				);
				if (!ready) reject(failure);
				for (const pending of [...bridge.pending.values()]) pending.reject(failure);
				bridge.pending.clear();
				if (this.bridge === bridge) this.bridge = undefined;
			});
		});
	}
}
