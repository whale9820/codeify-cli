import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { TUI } from "codeify-tui";
import { setKeybindings } from "codeify-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BackgroundTask, BackgroundTaskManager } from "../src/core/background-tasks.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { SshManager, SshProfileStore, sshArguments } from "../src/core/ssh-manager.ts";
import { createSshManageToolDefinition, createSshToolDefinition } from "../src/core/tools/ssh.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness } from "./suite/harness.ts";

describe("persistent SSH", () => {
	let dir: string;
	let manager: SshManager;
	let children: ChildProcessWithoutNullStreams[];
	let launches: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "codeify-ssh-"));
		children = [];
		launches = vi.fn(() => {
			const child = spawn("sh", [], { cwd: dir, stdio: "pipe", detached: process.platform !== "win32" });
			children.push(child);
			return child;
		});
		manager = new SshManager(dir, launches as typeof spawn);
		await manager.profiles.change("add", "codeify", { host: "codeify", configFile: "~/.ssh/codeify_vps" });
	});

	afterEach(async () => {
		const closed = children
			.filter((child) => child.exitCode === null && child.signalCode === null)
			.map((child) => once(child, "close"));
		manager.dispose();
		await Promise.all(closed);
		await rm(dir, { recursive: true, force: true });
	});

	async function run(command: string, profile = "codeify", signal?: AbortSignal, timeout?: number) {
		const chunks: Buffer[] = [];
		const result = await manager.exec(profile, command, dir, {
			onData: (data) => chunks.push(data),
			signal,
			timeout,
		});
		return { ...result, output: Buffer.concat(chunks).toString("utf8") };
	}

	it("reuses one process and preserves cwd, exports, variables and functions", async () => {
		await run("cd /; export SSH_TEST_VALUE='one two'; local_value=three; greet() { printf hello; }");
		const result = await run('pwd; printf "%s|%s|" "$SSH_TEST_VALUE" "$local_value"; greet');
		expect(result).toEqual({ exitCode: 0, output: "/\none two|three|hello" });
		expect(launches).toHaveBeenCalledTimes(1);
		expect(launches.mock.calls[0][0]).toBe("ssh");
		expect(manager.isConnected("codeify")).toBe(true);
	});

	it("supports quotes, multiline input, heredocs and commands that read stdin", async () => {
		await run("cat");
		expect((await run("cat <<'EOF'\nquote: ' 中文\nEOF\nprintf tail")).output).toBe("quote: ' 中文\ntail");
		expect((await run("printf '\\036not-a-marker\\037'")).output).toBe("\x1enot-a-marker\x1f");
	});

	it("decodes framing and UTF-8 even when every byte arrives separately", async () => {
		launches.mockImplementationOnce(() => {
			const child = spawn("sh", [], { cwd: dir, stdio: "pipe", detached: process.platform !== "win32" });
			children.push(child);
			const source = child.stdout;
			const fragmented = new PassThrough();
			source.on("data", (data: Buffer) => {
				for (let index = 0; index < data.length; index++) fragmented.write(data.subarray(index, index + 1));
			});
			Object.defineProperty(child, "stdout", { value: fragmented });
			return child;
		});
		await run("printf ready");
		expect(await run("printf '中文-without-newline'")).toEqual({ exitCode: 0, output: "中文-without-newline" });
	});

	it("cancels queued work promptly without closing the active shell", async () => {
		await run("printf ready");
		const active = run("sleep 0.1; state=ready");
		const controller = new AbortController();
		const queued = run("state=wrong", "codeify", controller.signal);
		const rejection = expect(queued).rejects.toThrow("aborted");
		controller.abort();
		await rejection;
		expect(manager.isConnected("codeify")).toBe(true);
		const following = run('printf "%s" "$state"');
		await active;
		expect((await following).output).toBe("ready");
	});

	it("keeps failed commands in the same shell and preserves stderr", async () => {
		await run("printf ready");
		expect(await run("printf problem >&2; false")).toEqual({ exitCode: 1, output: "problem" });
		expect((await run("printf still-alive")).output).toBe("still-alive");
		expect(launches).toHaveBeenCalledTimes(1);
	});

	it("serializes concurrent commands to a profile", async () => {
		const [first, second] = await Promise.all([
			run("sleep 0.05; state=ready; printf first"),
			run('printf "%s" "$state"'),
		]);
		expect(first.output).toContain("first");
		expect(second.output).toBe("ready");
		expect(launches).toHaveBeenCalledTimes(1);
	});

	it("keeps different profiles independent", async () => {
		await manager.profiles.change("add", "other", { host: "other" });
		await run("state=first");
		await run("state=second", "other");
		expect((await run('printf "%s" "$state"')).output).toBe("first");
		expect((await run('printf "%s" "$state"', "other")).output).toBe("second");
		expect(launches).toHaveBeenCalledTimes(2);
	});

	it("streams large output before command completion and hides framing", async () => {
		let streamed!: () => void;
		const ready = new Promise<void>((resolve) => {
			streamed = resolve;
		});
		const chunks: Buffer[] = [];
		let completed = false;
		const execution = manager
			.exec(
				"codeify",
				"i=0; while [ $i -lt 5000 ]; do printf 'line %s 中文\\n' $i; i=$((i+1)); done; sleep 0.1",
				dir,
				{
					onData: (data) => {
						chunks.push(data);
						if (data.includes(Buffer.from("line 100"))) streamed();
					},
				},
			)
			.then(() => {
				completed = true;
			});
		await ready;
		expect(completed).toBe(false);
		await execution;
		const output = Buffer.concat(chunks).toString("utf8");
		expect(output).toContain("line 4999 中文\n");
		expect(output).not.toContain("\x1e");
		expect(output).not.toContain("�");
	});

	it("closes on timeout, never replays and starts fresh on the next call", async () => {
		await run("state=old");
		await expect(run("printf before; sleep 10; printf after", "codeify", undefined, 0.05)).rejects.toThrow(
			"timeout:0.05",
		);
		expect(manager.isConnected("codeify")).toBe(false);
		const next = await run('printf "state=%s" "$state"');
		expect(next.output).toContain("start fresh");
		expect(next.output).toContain("state=");
		expect(next.output).not.toContain("state=old");
		expect(launches).toHaveBeenCalledTimes(2);
	});

	it("aborts an active command and permits reconnecting", async () => {
		await run("printf ready");
		const controller = new AbortController();
		const execution = manager.exec("codeify", "printf started; printf '%0100d' 0; sleep 10", dir, {
			signal: controller.signal,
			onData: (data) => {
				if (data.includes(Buffer.from("started"))) controller.abort();
			},
		});
		const rejection = expect(execution).rejects.toThrow("aborted");
		await rejection;
		expect(manager.isConnected("codeify")).toBe(false);
		expect((await run("printf recovered")).output).toContain("recovered");
		expect(launches).toHaveBeenCalledTimes(2);
	});

	it("includes SSH authentication diagnostics in the final tool error", async () => {
		launches.mockImplementationOnce(() => {
			const child = spawn("sh", ["-c", "printf 'Permission denied (publickey).\\n' >&2; exit 255"], {
				cwd: dir,
				stdio: "pipe",
				detached: process.platform !== "win32",
			});
			children.push(child);
			return child;
		});
		const tool = createSshToolDefinition(dir, manager);
		await expect(
			tool.execute("auth", { profile: "codeify", command: "pwd" }, undefined, undefined, { cwd: dir }),
		).rejects.toThrow("Permission denied (publickey).");
		expect(launches).toHaveBeenCalledTimes(1);
	});

	it("reports shell exit without replaying the command", async () => {
		await expect(run("exit 7")).rejects.toThrow("Command outcome may be unknown");
		expect(launches).toHaveBeenCalledTimes(1);
		expect((await run("printf new")).output).toContain("start fresh");
	});

	it("rejects new work after disposal", async () => {
		manager.dispose();
		await expect(run("printf no")).rejects.toThrow("disposed");
		expect(launches).not.toHaveBeenCalled();
	});

	it("keeps a backgrounded SSH command alive after turn cancellation and reuses its shell", async () => {
		let requestBackground!: () => void;
		const requested = new Promise<void>((resolve) => {
			requestBackground = resolve;
		});
		let outputStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			outputStarted = resolve;
		});
		let finish!: (task: BackgroundTask) => void;
		const finished = new Promise<BackgroundTask>((resolve) => {
			finish = resolve;
		});
		const tasks = new BackgroundTaskManager(finish);
		const tool = createSshToolDefinition(dir, manager, {
			background: { watch: () => ({ requested, dispose() {} }), adopt: (options) => tasks.adopt(options) },
		});
		const controller = new AbortController();
		const execution = tool.execute(
			"background",
			{
				profile: "codeify",
				command: `printf started; printf '%0100d' 0; while [ ! -f '${dir}/continue' ]; do sleep 0.01; done; state=preserved; printf completed`,
			},
			controller.signal,
			(update) => {
				if (update.content.some((part) => part.type === "text" && part.text.includes("started"))) outputStarted();
			},
			{ cwd: dir },
		);
		try {
			await started;
			requestBackground();
			const result = await execution;
			expect(result.content.some((part) => part.type === "text" && part.text.includes("background as task"))).toBe(
				true,
			);
			controller.abort();
			await writeFile(join(dir, "continue"), "");
			const task = await finished;
			expect(task.status).toBe("completed");
			expect(task.description).toContain("SSH (codeify)");
			expect(tasks.readOutput(task.id)?.text).toContain("completed");
			expect((await run('printf "%s" "$state"')).output).toBe("preserved");
			expect(launches).toHaveBeenCalledTimes(1);
		} finally {
			tasks.detach();
		}
	});

	it("exposes SSH in SDK defaults, respects tool filters, and uses the configured agent directory", async () => {
		const harness = await createHarness();
		try {
			const configuredDir = join(dir, "configured-agent");
			for (const filter of [
				{},
				{ noTools: "all" as const },
				{ noTools: "builtin" as const },
				{ tools: ["ssh"] },
				{ excludeTools: ["ssh", "ssh_manage"] },
			]) {
				const { session } = await createAgentSession({
					cwd: dir,
					agentDir: configuredDir,
					modelRuntime: harness.session.modelRuntime,
					model: harness.getModel(),
					resourceLoader: harness.session.resourceLoader,
					sessionManager: SessionManager.inMemory(dir),
					settingsManager: SettingsManager.inMemory(),
					...filter,
				});
				try {
					const names = session.getActiveToolNames();
					if (filter.tools) expect(names).toEqual(["ssh"]);
					else if (filter.noTools || filter.excludeTools) {
						expect(names.includes("ssh")).toBe(false);
						expect(names.includes("ssh_manage")).toBe(false);
					} else {
						expect(names.includes("ssh")).toBe(true);
						expect(names.includes("ssh_manage")).toBe(true);
						expect(session.systemPrompt).toContain("persistent SSH shell");
						const manage = session.agent.state.tools.find((tool) => tool.name === "ssh_manage")!;
						await manage.execute("add", { action: "add", name: "saved", profile: { host: "alias" } });
						expect(await new SshProfileStore(configuredDir).list()).toEqual({ saved: { host: "alias" } });
						session.setUserInputEnabled();
						expect(session.getActiveToolNames()).toContain("ssh");
					}
				} finally {
					session.dispose();
				}
			}
		} finally {
			harness.cleanup();
		}
	});

	it("persists CRUD changes across instances and removes optional fields", async () => {
		const store = new SshProfileStore(dir);
		await store.change("edit", "codeify", { user: "deploy", port: 2200, configFile: null });
		expect(await manager.profiles.list()).toEqual({ codeify: { host: "codeify", user: "deploy", port: 2200 } });
		expect((await stat(store.path)).mode & 0o777).toBe(0o600);
		await expect(store.change("add", "codeify", { host: "duplicate" })).rejects.toThrow("already exists");
		await expect(store.change("edit", "missing", { user: "nobody" })).rejects.toThrow("Unknown");
		await store.change("delete", "codeify");
		expect(await new SshProfileStore(dir).list()).toEqual({});
	});

	it("preserves simultaneous writes and leaves malformed files untouched", async () => {
		await Promise.all(
			Array.from({ length: 5 }, (_, index) =>
				new SshProfileStore(dir).change("add", `vps${index}`, { host: "localhost" }),
			),
		);
		expect(Object.keys(await manager.profiles.list())).toHaveLength(6);
		await writeFile(manager.profiles.path, "invalid json");
		await expect(manager.profiles.change("delete", "codeify")).rejects.toThrow();
		expect(await readFile(manager.profiles.path, "utf8")).toBe("invalid json");
	});

	it("uses argv for SSH configuration and rejects option injection", async () => {
		expect(sshArguments({ host: "::1" }).slice(-2)).toEqual(["::1", "exec sh"]);
		expect(
			sshArguments({
				host: "codeify",
				configFile: "/tmp/a b",
				identityFile: "/tmp/key'file",
				user: "root",
				port: 2200,
			}),
		).toEqual([
			"-T",
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=15",
			"-o",
			"ServerAliveInterval=30",
			"-o",
			"ServerAliveCountMax=3",
			"-F",
			"/tmp/a b",
			"-i",
			"/tmp/key'file",
			"-p",
			"2200",
			"-l",
			"root",
			"codeify",
			"exec sh",
		]);
		for (const host of ["-oProxyCommand=bad", "host; echo bad", "root@host", "host\nother"]) {
			await expect(manager.profiles.change("add", "bad", { host })).rejects.toThrow();
		}
		await expect(manager.profiles.change("add", "../escape", { host: "safe" })).rejects.toThrow();
	});

	it("management edits and disconnects close the live shell but retain saved profiles", async () => {
		const tool = createSshManageToolDefinition(manager);
		const ctx = { cwd: dir };
		await run("state=old");
		await tool.execute(
			"edit",
			{ action: "edit", name: "codeify", profile: { user: "deploy" } },
			undefined,
			undefined,
			ctx,
		);
		expect(manager.isConnected("codeify")).toBe(false);
		await run("state=new");
		await tool.execute("disconnect", { action: "disconnect", name: "codeify" }, undefined, undefined, ctx);
		expect(manager.isConnected("codeify")).toBe(false);
		expect((await manager.profiles.list()).codeify.user).toBe("deploy");
	});

	it("renders SSH(command) with the profile muted and retains output expansion", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const definition = createSshToolDefinition(dir, manager);
		const component = new ToolExecutionComponent(
			"ssh",
			"ssh-render",
			{ profile: "codeify", command: "cd /root/qoder/re" },
			{},
			definition,
			{ requestRender() {} } as unknown as TUI,
			dir,
		);
		const rendered = component.render(120).join("\n");
		expect(stripAnsi(rendered).trim()).toBe("● SSH(cd /root/qoder/re) (codeify)");
		expect(rendered).toContain(theme.fg("muted", " (codeify)"));
		const result = await definition.execute(
			"output",
			{ profile: "codeify", command: "i=0; while [ $i -lt 100 ]; do echo line-$i; i=$((i+1)); done" },
			undefined,
			undefined,
			{ cwd: dir },
		);
		component.updateResult({ ...result, isError: false });
		expect(stripAnsi(component.render(80).join("\n"))).toContain("to expand");
		component.setExpanded(true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("line-99");
	});
});
