import { readFileSync } from "node:fs";
import * as path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

interface CommandCall {
	args: string[];
	command: string;
}

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
							rmSync: vi.fn(),
							symlinkSync: vi.fn(),
							writeFileSync: vi.fn(),
						};
					case "node:os":
						return { homedir: () => "C:\\Users\\test" };
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
			args: ["/d", "/s", "/c", "npm.cmd ci --ignore-scripts"],
		});
		expect(calls).toContainEqual({
			command: "C:\\Windows\\System32\\cmd.exe",
			args: ["/d", "/s", "/c", "npm.cmd run build:runtime"],
		});
		expect(calls.some((call) => call.command === "npm.cmd")).toBe(false);
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
							rmSync: vi.fn(),
							symlinkSync,
							writeFileSync: vi.fn(),
						};
					case "node:os":
						return { homedir: () => "/root" };
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
});
