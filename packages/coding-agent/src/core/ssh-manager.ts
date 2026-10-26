import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { getShellEnv, killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../utils/shell.ts";
import type { BashOperations } from "./tools/bash.ts";

export interface SshProfile {
	host: string;
	user?: string;
	port?: number;
	identityFile?: string;
	configFile?: string;
}

type SshProfilePatch = { [K in keyof SshProfile]?: SshProfile[K] | null };

function validateName(name: string): void {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/u.test(name)) {
		throw new Error(
			"SSH profile name must be 1–64 letters, digits, dots, underscores or hyphens, starting with a letter or digit.",
		);
	}
}

function validateProfile(value: unknown): SshProfile {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid SSH profile.");
	const profile = value as Record<string, unknown>;
	if (
		typeof profile.host !== "string" ||
		(!isIP(profile.host) && !/^[a-zA-Z0-9][a-zA-Z0-9_.:%-]*$/u.test(profile.host))
	) {
		throw new Error("SSH host must be a hostname, IP address or SSH config alias, without a user or options.");
	}
	if (
		profile.user !== undefined &&
		(typeof profile.user !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(profile.user))
	) {
		throw new Error("Invalid SSH user.");
	}
	if (
		profile.port !== undefined &&
		(typeof profile.port !== "number" || !Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535)
	) {
		throw new Error("SSH port must be an integer between 1 and 65535.");
	}
	for (const key of ["identityFile", "configFile"] as const) {
		if (
			profile[key] !== undefined &&
			(typeof profile[key] !== "string" || !profile[key] || /[\0\r\n]/u.test(profile[key]))
		) {
			throw new Error(`Invalid SSH ${key}.`);
		}
	}
	if (Object.keys(profile).some((key) => !["host", "user", "port", "identityFile", "configFile"].includes(key))) {
		throw new Error("Unknown SSH profile field. Store key paths, never passwords or private key contents.");
	}
	return profile as unknown as SshProfile;
}

export class SshProfileStore {
	readonly path: string;

	constructor(agentDir = getAgentDir()) {
		this.path = join(agentDir, "ssh.json");
	}

	async list(): Promise<Record<string, SshProfile>> {
		let text: string;
		try {
			text = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
		const value: unknown = JSON.parse(text);
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error(`Invalid SSH profiles: ${this.path}`);
		const profiles: Record<string, SshProfile> = Object.create(null);
		for (const [name, profile] of Object.entries(value)) {
			validateName(name);
			profiles[name] = validateProfile(profile);
		}
		return profiles;
	}

	async change(action: "add" | "edit" | "delete", name: string, profile?: SshProfilePatch): Promise<void> {
		validateName(name);
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const release = await lockfile.lock(this.path, {
			realpath: false,
			retries: { retries: 10, minTimeout: 20, maxTimeout: 100 },
		});
		const temp = `${this.path}.${randomBytes(8).toString("hex")}.tmp`;
		try {
			const profiles = await this.list();
			const exists = Object.hasOwn(profiles, name);
			if (action === "add" && exists) throw new Error(`SSH profile already exists: ${name}. Use edit.`);
			if (action !== "add" && !exists) throw new Error(`Unknown SSH profile: ${name}`);
			if (action === "delete") delete profiles[name];
			else {
				const merged = { ...(action === "edit" ? profiles[name] : {}), ...profile };
				const updated = validateProfile(
					Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== null)),
				);
				for (const key of ["identityFile", "configFile"] as const) {
					if (updated[key]) updated[key] = resolvePath(updated[key]);
				}
				profiles[name] = updated;
			}
			await writeFile(temp, `${JSON.stringify(profiles, null, 2)}\n`, { mode: 0o600, flag: "wx" });
			await rename(temp, this.path);
		} finally {
			try {
				await rm(temp, { force: true });
			} finally {
				await release();
			}
		}
	}
}

export function sshArguments(profile: SshProfile): string[] {
	validateProfile(profile);
	const args = [
		"-T",
		"-o",
		"BatchMode=yes",
		"-o",
		"ConnectTimeout=15",
		"-o",
		"ServerAliveInterval=30",
		"-o",
		"ServerAliveCountMax=3",
	];
	if (profile.configFile) args.push("-F", profile.configFile);
	if (profile.identityFile) args.push("-i", profile.identityFile);
	if (profile.port) args.push("-p", String(profile.port));
	if (profile.user) args.push("-l", profile.user);
	args.push(profile.host, "exec sh");
	return args;
}

function quoteShell(value: string): string {
	return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

type ExecOptions = Parameters<BashOperations["exec"]>[2];

interface PendingCommand {
	prefix: Buffer;
	buffer: Buffer;
	onData: (data: Buffer) => void;
	resolve: (result: { exitCode: number }) => void;
	reject: (error: Error) => void;
}

class SshShell {
	readonly fingerprint: string;
	private child: ChildProcessWithoutNullStreams;
	private pending?: PendingCommand;
	private closed = false;
	private diagnostics = Buffer.alloc(0);

	constructor(profile: SshProfile, cwd: string, start: typeof spawn) {
		this.fingerprint = JSON.stringify(profile);
		this.child = start("ssh", sshArguments(profile), {
			cwd,
			env: getShellEnv(),
			detached: process.platform !== "win32",
			stdio: "pipe",
			windowsHide: true,
		});
		if (this.child.pid) trackDetachedChildPid(this.child.pid);
		this.child.stdout.on("data", (data: Buffer) => this.receive(data));
		this.child.stderr.on("data", (data: Buffer) => {
			this.diagnostics = Buffer.concat([this.diagnostics, data]).subarray(-8192);
			this.pending?.onData(data);
		});
		this.child.stdin.on("error", (error: Error) => this.close(error));
		this.child.on("error", (error: Error) => this.close(error));
		this.child.on("close", (code, signal) =>
			this.close(
				new Error(
					`SSH shell closed (${signal ?? code}). Command outcome may be unknown; shell state was lost. The next call opens a new shell. Do not blindly retry a mutation.`,
				),
			),
		);
	}

	get connected(): boolean {
		return !this.closed;
	}

	private receive(data: Buffer): void {
		const pending = this.pending;
		if (!pending) return;
		pending.buffer = Buffer.concat([pending.buffer, data]);
		const index = pending.buffer.indexOf(pending.prefix);
		if (index >= 0) {
			const end = pending.buffer.indexOf(0x1f, index + pending.prefix.length);
			if (end >= 0) {
				const status = pending.buffer.subarray(index + pending.prefix.length, end).toString("ascii");
				if (!/^\d{1,3}$/u.test(status)) {
					this.close(new Error("Invalid SSH shell response. Shell state was lost."));
					return;
				}
				if (index > 0) pending.onData(pending.buffer.subarray(0, index));
				this.pending = undefined;
				pending.resolve({ exitCode: Number(status) });
				return;
			}
		}
		const emitLength = index >= 0 ? index : Math.max(0, pending.buffer.length - pending.prefix.length + 1);
		if (emitLength > 0) {
			const output = pending.buffer.subarray(0, emitLength);
			pending.buffer = pending.buffer.subarray(emitLength);
			pending.onData(output);
		}
	}

	async exec(command: string, options: ExecOptions): Promise<{ exitCode: number }> {
		if (this.closed) throw new Error("SSH shell is closed. The next call opens a new shell.");
		if (command.includes("\0")) throw new Error("SSH commands cannot contain NUL bytes.");
		const token = randomBytes(24).toString("hex");
		this.diagnostics = Buffer.alloc(0);
		let timer: NodeJS.Timeout | undefined;
		const abort = () => this.close(new Error("aborted"));
		try {
			return await new Promise<{ exitCode: number }>((resolve, reject) => {
				this.pending = {
					prefix: Buffer.from(`\x1e${token}:`),
					buffer: Buffer.alloc(0),
					onData: options.onData,
					resolve,
					reject,
				};
				options.signal?.addEventListener("abort", abort, { once: true });
				if (options.signal?.aborted) {
					abort();
					return;
				}
				if (options.timeout !== undefined)
					timer = setTimeout(() => this.close(new Error(`timeout:${options.timeout}`)), options.timeout * 1000);
				this.child.stdin.write(
					`eval ${quoteShell(command)} </dev/null 2>&1\ncommand printf '\\036${token}:%s\\037' "$?"\n`,
				);
			});
		} finally {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
		}
	}

	close(error = new Error("SSH shell disconnected. Shell state was lost.")): void {
		if (this.closed) return;
		this.closed = true;
		if (this.child.pid) {
			killProcessTree(this.child.pid);
			untrackDetachedChildPid(this.child.pid);
		}
		const pending = this.pending;
		this.pending = undefined;
		if (pending) {
			if (pending.buffer.length) pending.onData(pending.buffer);
			pending.reject(
				this.diagnostics.length && error.message !== "aborted" && !error.message.startsWith("timeout:")
					? new Error(`${error.message}\n${this.diagnostics.toString("utf8").trim()}`)
					: error,
			);
		}
	}
}

export class SshManager {
	readonly profiles: SshProfileStore;
	private shells = new Map<string, SshShell>();
	private queues = new Map<string, Promise<void>>();
	private start: typeof spawn;
	private disposed = false;

	constructor(agentDir = getAgentDir(), start: typeof spawn = spawn) {
		this.profiles = new SshProfileStore(agentDir);
		this.start = start;
	}

	isConnected(name: string): boolean {
		return this.shells.get(name)?.connected ?? false;
	}

	async exec(name: string, command: string, cwd: string, options: ExecOptions): Promise<{ exitCode: number }> {
		if (
			options.timeout !== undefined &&
			(!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout * 1000 > 2_147_483_647)
		)
			throw new Error("Invalid SSH timeout.");
		const previous = this.queues.get(name) ?? Promise.resolve();
		let release!: () => void;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		const queued = previous.then(() => next);
		this.queues.set(name, queued);
		try {
			await new Promise<void>((resolve, reject) => {
				const abort = () => reject(new Error("aborted"));
				previous.then(() => {
					options.signal?.removeEventListener("abort", abort);
					resolve();
				});
				if (options.signal?.aborted) abort();
				else options.signal?.addEventListener("abort", abort, { once: true });
			});
			if (this.disposed) throw new Error("SSH manager is disposed.");
			if (options.signal?.aborted) throw new Error("aborted");
			const profiles = await this.profiles.list();
			if (this.disposed) throw new Error("SSH manager is disposed.");
			if (!Object.hasOwn(profiles, name)) throw new Error(`Unknown SSH profile: ${name}. Use ssh_manage to add it.`);
			const profile = profiles[name];
			let shell = this.shells.get(name);
			if (!shell?.connected || shell.fingerprint !== JSON.stringify(profile)) {
				shell?.close();
				shell = new SshShell(profile, cwd, this.start);
				this.shells.set(name, shell);
				options.onData(Buffer.from("[Opening a new SSH shell; working directory and environment start fresh.]\n"));
			}
			return await shell.exec(command, options);
		} finally {
			release();
			void queued.then(() => {
				if (this.queues.get(name) === queued) this.queues.delete(name);
			});
		}
	}

	disconnect(name: string): void {
		this.shells.get(name)?.close();
		this.shells.delete(name);
	}

	dispose(): void {
		this.disposed = true;
		for (const shell of this.shells.values()) shell.close();
		this.shells.clear();
	}
}
