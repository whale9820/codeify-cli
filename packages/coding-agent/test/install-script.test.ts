import { readFileSync } from "node:fs";
import * as path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

interface CommandCall {
	args: string[];
	command: string;
	env?: Record<string, string>;
}

const compilerPackageJson = '{"devDependencies":{"@typescript/native-preview":"7.0.0-dev.20260120.1"}}';

describe("Codeify install script", () => {
	it("runs npm command shims through cmd.exe on Windows", () => {
		const calls: CommandCall[] = [];
		const execFileSync = vi.fn((command: string, args: string[]) => {
			calls.push({ command, args });
			return command === "C:\\Program Files\\nodejs\\node.exe" ? "0.81.1\n" : "";
		});
		const processMock = {
			env: {
				ComSpec: "C:\\Windows\\System32\\cmd.exe",
				LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
				PATH: "",
			},
			execPath: "C:\\Program Files\\nodejs\\node.exe",
			platform: "win32",
			stderr: { write: vi.fn() },
			versions: { node: "24.15.0" },
		};
		const source = readFileSync(new URL("../../../scripts/install.cjs", import.meta.url), "utf8");

		vm.runInNewContext(source, {
			console: { log: vi.fn() },
			process: processMock,
			require: (specifier: string) => {
				switch (specifier) {
					case "node:child_process":
						return { execFileSync };
					case "node:fs":
						return {
							chmodSync: vi.fn(),
							existsSync: vi.fn(() => false),
							lstatSync: vi.fn(),
							mkdirSync: vi.fn(),
							mkdtempSync: vi.fn(() => "C:\\Users\\test\\AppData\\Local\\Temp\\codeify-compiler"),
							readFileSync: vi.fn(() => compilerPackageJson),
							rmSync: vi.fn(),
							symlinkSync: vi.fn(),
							writeFileSync: vi.fn(),
						};
					case "node:os":
						return { homedir: () => "C:\\Users\\test", tmpdir: () => "C:\\Users\\test\\AppData\\Local\\Temp" };
					case "node:path":
						return path;
					default:
						throw new Error(`Unexpected import: ${specifier}`);
				}
			},
		});

		expect(calls).toContainEqual({
			command: "C:\\Windows\\System32\\cmd.exe",
			args: ["/d", "/s", "/c", "npm.cmd --version"],
		});
		expect(calls).toContainEqual({
			command: "C:\\Windows\\System32\\cmd.exe",
			args: ["/d", "/s", "/c", "npm.cmd ci --omit=dev --ignore-scripts"],
		});
		expect(calls.some((call) => call.args.some((arg) => arg.endsWith("build-lowmem.mjs")))).toBe(true);
		expect(calls.some((call) => call.command === "npm.cmd")).toBe(false);
	});

	it("downloads a source archive on Windows when Git is unavailable", () => {
		const calls: CommandCall[] = [];
		const cpSync = vi.fn();
		const writeFileSync = vi.fn();
		const execFileSync = vi.fn((command: string, args: string[]) => {
			calls.push({ command, args });
			if (command === "git") throw new Error("not found");
			return command === "C:\\Program Files\\nodejs\\node.exe" ? "0.82.6\n" : "";
		});
		const processMock = {
			env: {
				ComSpec: "C:\\Windows\\System32\\cmd.exe",
				LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
				PATH: "",
			},
			execPath: "C:\\Program Files\\nodejs\\node.exe",
			platform: "win32",
			stderr: { write: vi.fn() },
			versions: { node: "24.15.0" },
		};
		const source = readFileSync(new URL("../../../scripts/install.cjs", import.meta.url), "utf8");

		vm.runInNewContext(source, {
			console: { log: vi.fn() },
			process: processMock,
			require: (specifier: string) => {
				switch (specifier) {
					case "node:child_process":
						return { execFileSync };
					case "node:fs":
						return {
							chmodSync: vi.fn(),
							cpSync,
							existsSync: vi.fn(() => false),
							lstatSync: vi.fn(),
							mkdirSync: vi.fn(),
							mkdtempSync: vi.fn(() => "C:\\Users\\test\\AppData\\Local\\codeify-download-test"),
							readFileSync: vi.fn(() => compilerPackageJson),
							readdirSync: vi.fn(() => ["codeify-cli-main"]),
							rmSync: vi.fn(),
							statSync: vi.fn(() => ({ isDirectory: () => true })),
							symlinkSync: vi.fn(),
							writeFileSync,
						};
					case "node:os":
						return { homedir: () => "C:\\Users\\test", tmpdir: () => "C:\\Users\\test\\AppData\\Local\\Temp" };
					case "node:path":
						return path;
					default:
						throw new Error(`Unexpected import: ${specifier}`);
				}
			},
		});

		expect(cpSync).toHaveBeenCalledOnce();
		expect(writeFileSync).toHaveBeenCalledWith(expect.stringContaining(".codeify-archive-install"), "", "ascii");
		expect(calls).toContainEqual({
			command: "C:\\Windows\\System32\\cmd.exe",
			args: ["/d", "/s", "/c", "npm.cmd ci --omit=dev --ignore-scripts"],
		});
		expect(calls.some((call) => call.command === "git" && call.args.includes("clone"))).toBe(false);
		expect(
			calls.some(
				(call) => call.command === "powershell.exe" && call.args.some((arg) => arg.includes("Expand-Archive")),
			),
		).toBe(true);
	});

	it("updates existing Windows installs without deleting the live dependency tree", () => {
		const calls: CommandCall[] = [];
		const execFileSync = vi.fn((command: string, args: string[]) => {
			calls.push({ command, args });
			return command === "C:\\Program Files\\nodejs\\node.exe" ? "0.81.1\n" : "";
		});
		const processMock = {
			env: {
				ComSpec: "C:\\Windows\\System32\\cmd.exe",
				LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
				PATH: "",
			},
			execPath: "C:\\Program Files\\nodejs\\node.exe",
			platform: "win32",
			stderr: { write: vi.fn() },
			versions: { node: "24.15.0" },
		};
		const source = readFileSync(new URL("../../../scripts/install.cjs", import.meta.url), "utf8");

		vm.runInNewContext(source, {
			console: { log: vi.fn() },
			process: processMock,
			require: (specifier: string) => {
				switch (specifier) {
					case "node:child_process":
						return { execFileSync };
					case "node:fs":
						return {
							chmodSync: vi.fn(),
							existsSync: vi.fn((file: string) => file.endsWith(".git")),
							lstatSync: vi.fn(),
							mkdirSync: vi.fn(),
							mkdtempSync: vi.fn(() => "C:\\Users\\test\\AppData\\Local\\Temp\\codeify-compiler"),
							readFileSync: vi.fn(() => compilerPackageJson),
							rmSync: vi.fn(),
							symlinkSync: vi.fn(),
							writeFileSync: vi.fn(),
						};
					case "node:os":
						return { homedir: () => "C:\\Users\\test", tmpdir: () => "C:\\Users\\test\\AppData\\Local\\Temp" };
					case "node:path":
						return path;
					default:
						throw new Error(`Unexpected import: ${specifier}`);
				}
			},
		});

		expect(calls).toContainEqual({
			command: "C:\\Windows\\System32\\cmd.exe",
			args: ["/d", "/s", "/c", "npm.cmd install --omit=dev --ignore-scripts"],
		});
		expect(calls).toContainEqual({
			command: "git",
			args: ["-C", "C:\\Users\\test\\AppData\\Local/CodeifyCLI", "pull", "--ff-only", "origin", "main"],
		});
		expect(calls.some((call) => call.args.at(-1) === "npm.cmd ci --ignore-scripts")).toBe(false);
	});

	it("removes Unix dependencies before updating the source checkout", () => {
		const installHome = "/root/.local/share/codeify-cli";
		const rmSync = vi.fn();
		const calls: CommandCall[] = [];
		const execFileSync = vi.fn((command: string, args: string[]) => {
			calls.push({ command, args });
			return command === "/usr/bin/node" ? "0.82.12\\n" : "";
		});
		const source = readFileSync(new URL("../../../scripts/install.cjs", import.meta.url), "utf8");

		vm.runInNewContext(source, {
			console: { log: vi.fn() },
			process: {
				env: { PATH: "/usr/local/bin" },
				execPath: "/usr/bin/node",
				platform: "linux",
				stderr: { write: vi.fn() },
				versions: { node: "24.15.0" },
			},
			require: (specifier: string) => {
				switch (specifier) {
					case "node:child_process":
						return { execFileSync };
					case "node:fs":
						return {
							accessSync: vi.fn(),
							chmodSync: vi.fn(),
							constants: { W_OK: 2 },
							existsSync: vi.fn((file: string) => file === `${installHome}/.git`),
							lstatSync: vi.fn(),
							mkdirSync: vi.fn(),
							mkdtempSync: vi.fn(() => "/tmp/codeify-compiler"),
							readFileSync: vi.fn(() => compilerPackageJson),
							rmSync,
							symlinkSync: vi.fn(),
							writeFileSync: vi.fn(),
						};
					case "node:os":
						return { homedir: () => "/root", tmpdir: () => "/tmp", totalmem: () => 16 * gigabyte };
					case "node:path":
						return path;
					default:
						throw new Error(`Unexpected import: ${specifier}`);
				}
			},
		});

		expect(rmSync).toHaveBeenCalledWith(`${installHome}/node_modules`, { force: true, recursive: true });
		expect(calls).toContainEqual({
			command: "git",
			args: ["-C", installHome, "pull", "--ff-only", "origin", "main"],
		});
	});

	it("removes a fresh checkout when dependency installation fails", () => {
		const installHome = "/tmp/codeify-install-test";
		const rmSync = vi.fn();
		const execFileSync = vi.fn((command: string, args: string[]) => {
			if (command === "npm" && args.includes("ci")) throw new Error("ENOSPC");
			return "";
		});
		const source = readFileSync(new URL("../../../scripts/install.cjs", import.meta.url), "utf8");

		expect(() =>
			vm.runInNewContext(source, {
				console: { log: vi.fn() },
				process: {
					env: { CODEIFY_INSTALL_HOME: installHome, PATH: "/usr/local/bin" },
					execPath: "/usr/bin/node",
					platform: "linux",
					stderr: { write: vi.fn() },
					versions: { node: "24.15.0" },
				},
				require: (specifier: string) => {
					switch (specifier) {
						case "node:child_process":
							return { execFileSync };
						case "node:fs":
							return {
								accessSync: vi.fn(),
								chmodSync: vi.fn(),
								constants: { W_OK: 2 },
								existsSync: vi.fn(() => false),
								lstatSync: vi.fn(),
								mkdirSync: vi.fn(),
								mkdtempSync: vi.fn(() => "/tmp/codeify-compiler"),
								readFileSync: vi.fn(() => compilerPackageJson),
								rmSync,
								symlinkSync: vi.fn(),
								writeFileSync: vi.fn(),
							};
						case "node:os":
							return { homedir: () => "/root", tmpdir: () => "/tmp", totalmem: () => gigabyte };
						case "node:path":
							return path;
						default:
							throw new Error(`Unexpected import: ${specifier}`);
					}
				},
			}),
		).toThrow(/disk space/);
		expect(rmSync).toHaveBeenCalledWith(installHome, { force: true, recursive: true });
	});

	it("installs into an existing writable PATH directory on Unix", () => {
		const symlinkSync = vi.fn();
		const execFileSync = vi.fn((command: string) => (command === "/usr/bin/node" ? "0.81.1\n" : ""));
		const processMock = {
			env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin" },
			execPath: "/usr/bin/node",
			platform: "linux",
			stderr: { write: vi.fn() },
			versions: { node: "24.15.0" },
		};
		const source = readFileSync(new URL("../../../scripts/install.cjs", import.meta.url), "utf8");

		vm.runInNewContext(source, {
			console: { log: vi.fn() },
			process: processMock,
			require: (specifier: string) => {
				switch (specifier) {
					case "node:child_process":
						return { execFileSync };
					case "node:fs":
						return {
							accessSync: vi.fn((directory: string) => {
								if (directory !== "/usr/local/bin") throw new Error("not writable");
							}),
							chmodSync: vi.fn(),
							constants: { W_OK: 2 },
							existsSync: vi.fn((file: string) => file === "/usr/local/bin"),
							lstatSync: vi.fn(),
							mkdirSync: vi.fn(),
							mkdtempSync: vi.fn(() => "/tmp/codeify-compiler"),
							readFileSync: vi.fn(() => compilerPackageJson),
							rmSync: vi.fn(),
							symlinkSync,
							writeFileSync: vi.fn(),
						};
					case "node:os":
						return { homedir: () => "/root", tmpdir: () => "/tmp" };
					case "node:path":
						return path;
					default:
						throw new Error(`Unexpected import: ${specifier}`);
				}
			},
		});

		expect(symlinkSync).toHaveBeenCalledWith(
			"/root/.local/share/codeify-cli/packages/coding-agent/dist/cli.js",
			"/usr/local/bin/codeify",
		);
	});

	function runUnixInstaller(totalmem: (() => number) | undefined, env: Record<string, string> = {}) {
		const calls: CommandCall[] = [];
		const execFileSync = vi.fn((command: string, args: string[], options: { env?: Record<string, string> }) => {
			calls.push({ command, args, env: options?.env });
			return command === "/usr/bin/node" ? "0.81.1\n" : "";
		});
		const source = readFileSync(new URL("../../../scripts/install.cjs", import.meta.url), "utf8");

		vm.runInNewContext(source, {
			console: { log: vi.fn() },
			process: {
				env: { PATH: "/usr/local/bin", ...env },
				execPath: "/usr/bin/node",
				platform: "linux",
				stderr: { write: vi.fn() },
				versions: { node: "24.15.0" },
			},
			require: (specifier: string) => {
				switch (specifier) {
					case "node:child_process":
						return { execFileSync };
					case "node:fs":
						return {
							accessSync: vi.fn(),
							chmodSync: vi.fn(),
							constants: { W_OK: 2 },
							existsSync: vi.fn(() => false),
							lstatSync: vi.fn(),
							mkdirSync: vi.fn(),
							mkdtempSync: vi.fn(() => "/tmp/codeify-compiler"),
							readFileSync: vi.fn(() => compilerPackageJson),
							rmSync: vi.fn(),
							symlinkSync: vi.fn(),
							writeFileSync: vi.fn(),
						};
					case "node:os":
						return totalmem
							? { homedir: () => "/root", tmpdir: () => "/tmp", totalmem }
							: { homedir: () => "/root", tmpdir: () => "/tmp" };
					case "node:path":
						return path;
					default:
						throw new Error(`Unexpected import: ${specifier}`);
				}
			},
		});
		return calls;
	}

	const gigabyte = 1024 * 1024 * 1024;

	it("uses the low-memory build path on small hosts", () => {
		const calls = runUnixInstaller(() => 2 * gigabyte);

		expect(calls.some((call) => call.args.includes("build:runtime"))).toBe(false);
		expect(
			calls.some(
				(call) => call.command === "/usr/bin/node" && call.args.some((arg) => arg.endsWith("build-lowmem.mjs")),
			),
		).toBe(true);

		const install = calls.find((call) => call.args.includes("ci"));
		expect(install?.env?.NODE_OPTIONS).toBe("--max-old-space-size=256");
	});

	it("uses the standard build path on hosts with enough memory", () => {
		const calls = runUnixInstaller(() => 16 * gigabyte, { CODEIFY_INSTALL_LOW_MEMORY: "0" });

		expect(calls.some((call) => call.args.includes("build:runtime"))).toBe(true);
		expect(calls.some((call) => call.args.some((arg) => arg.endsWith("build-lowmem.mjs")))).toBe(false);
		expect(calls.find((call) => call.args.includes("ci"))?.env?.NODE_OPTIONS).toBeUndefined();
	});

	it("honors CODEIFY_INSTALL_LOW_MEMORY overrides", () => {
		const forcedOn = runUnixInstaller(() => 16 * gigabyte, { CODEIFY_INSTALL_LOW_MEMORY: "1" });
		expect(forcedOn.some((call) => call.args.some((arg) => arg.endsWith("build-lowmem.mjs")))).toBe(true);

		const forcedOff = runUnixInstaller(() => gigabyte, { CODEIFY_INSTALL_LOW_MEMORY: "0" });
		expect(forcedOff.some((call) => call.args.includes("build:runtime"))).toBe(true);
	});

	it("uses the minimal build when totalmem is unavailable", () => {
		const calls = runUnixInstaller(undefined);
		expect(calls.some((call) => call.args.some((arg) => arg.endsWith("build-lowmem.mjs")))).toBe(true);
	});

	it.each([undefined, "dependencies", "build", "verify"])(
		"records completion only after a successful install (failure: %s)",
		(failure) => {
			const installHome = "/tmp/codeify-marker-test";
			const marker = `${installHome}/.codeify-install-complete`;
			let completed = true;
			let verified = false;
			const execFileSync = vi.fn((command: string, args: string[]) => {
				if (args.includes("pull")) expect(completed).toBe(false);
				const phase = args.includes("ci")
					? "dependencies"
					: args.some((arg) => arg.endsWith("build-lowmem.mjs"))
						? "build"
						: command === "/usr/bin/node" && args.includes("--version")
							? "verify"
							: undefined;
				if (phase !== undefined && phase === failure) throw new Error("Interrupted");
				if (phase === "verify") verified = true;
				return phase === "verify" ? "0.82.14\n" : "";
			});
			const source = readFileSync(new URL("../../../scripts/install.cjs", import.meta.url), "utf8");
			const run = () =>
				vm.runInNewContext(source, {
					console: { log: vi.fn() },
					process: {
						env: { CODEIFY_INSTALL_HOME: installHome, PATH: "/usr/local/bin" },
						execPath: "/usr/bin/node",
						platform: "linux",
						stderr: { write: vi.fn() },
						versions: { node: "24.15.0" },
					},
					require: (specifier: string) => {
						switch (specifier) {
							case "node:child_process":
								return { execFileSync };
							case "node:path":
								return path;
							case "node:os":
								return { homedir: () => "/root", tmpdir: () => "/tmp", totalmem: () => gigabyte };
							case "node:fs":
								return {
									accessSync: vi.fn(),
									constants: { W_OK: 2 },
									chmodSync: vi.fn(),
									existsSync: (file: string) => file === `${installHome}/.git`,
									mkdirSync: vi.fn(),
									mkdtempSync: () => "/tmp/codeify-compiler",
									readFileSync: () => compilerPackageJson,
									rmSync: (file: string) => {
										if (file === marker) completed = false;
									},
									symlinkSync: vi.fn(),
									writeFileSync: (file: string, contents: string) => {
										if (file === marker) {
											expect(verified).toBe(true);
											expect(contents).toBe("0.82.14\n");
											completed = true;
										}
									},
								};
							default:
								throw new Error(`Unexpected import: ${specifier}`);
						}
					},
				});
			if (failure) expect(run).toThrow("Interrupted");
			else run();
			expect(completed).toBe(failure === undefined);
		},
	);

	it("reports an out-of-memory hint when a build step is killed", () => {
		const source = readFileSync(new URL("../../../scripts/install.cjs", import.meta.url), "utf8");
		const execFileSync = vi.fn((_command: string, args: string[]) => {
			if (args.some((arg) => arg.endsWith("build-lowmem.mjs"))) {
				const error: NodeJS.ErrnoException & { signal?: string } = new Error("killed");
				error.signal = "SIGKILL";
				throw error;
			}
			return "";
		});

		expect(() =>
			vm.runInNewContext(source, {
				console: { log: vi.fn() },
				process: {
					env: { PATH: "/usr/local/bin" },
					execPath: "/usr/bin/node",
					platform: "linux",
					stderr: { write: vi.fn() },
					versions: { node: "24.15.0" },
				},
				require: (specifier: string) => {
					switch (specifier) {
						case "node:child_process":
							return { execFileSync };
						case "node:fs":
							return {
								accessSync: vi.fn(),
								chmodSync: vi.fn(),
								constants: { W_OK: 2 },
								existsSync: vi.fn(() => false),
								lstatSync: vi.fn(),
								mkdirSync: vi.fn(),
								mkdtempSync: vi.fn(() => "/tmp/codeify-compiler"),
								readFileSync: vi.fn(() => compilerPackageJson),
								rmSync: vi.fn(),
								symlinkSync: vi.fn(),
								writeFileSync: vi.fn(),
							};
						case "node:os":
							return { homedir: () => "/root", tmpdir: () => "/tmp", totalmem: () => gigabyte };
						case "node:path":
							return path;
						default:
							throw new Error(`Unexpected import: ${specifier}`);
					}
				},
			}),
		).toThrow(/ran out of memory/);
	});
});
