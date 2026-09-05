import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";

const packageDirectories = [
	"packages/tui",
	"packages/ai",
	"packages/agent",
	"packages/storage/sqlite-node",
	"packages/coding-agent",
	"packages/server",
];
const directories: string[] = [];
const source = fs.readFileSync(new URL("../../../scripts/build-lowmem.mjs", import.meta.url), "utf8");

afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function createFixture(existing = true) {
	const root = fs.mkdtempSync(path.join(tmpdir(), "codeify-build-test-"));
	directories.push(root);
	for (const directory of packageDirectories) {
		fs.mkdirSync(path.join(root, directory), { recursive: true });
		fs.writeFileSync(path.join(root, directory, "tsconfig.build.json"), JSON.stringify({ compilerOptions: {} }));
		if (existing) {
			fs.mkdirSync(path.join(root, directory, "dist"));
			fs.writeFileSync(path.join(root, directory, "dist", "settings-manager.js"), "old settings");
			fs.writeFileSync(path.join(root, directory, "dist", "interactive-mode.js"), "old interactive");
			fs.writeFileSync(path.join(root, directory, "dist", "obsolete.js"), "obsolete");
		}
	}
	const assets = {
		"packages/ai/src/providers/test.models.ts": "export const models = {};",
		"packages/storage/sqlite-node/src/sqlite/migrations/001.sql": "SELECT 1;",
		"packages/coding-agent/src/modes/interactive/theme/dark.json": "{}",
		"packages/coding-agent/src/modes/interactive/assets/header.png": "image",
		"packages/coding-agent/src/core/export-html/template.html": "<html></html>",
		"packages/coding-agent/src/core/export-html/vendor/highlight.js": "vendor",
		"packages/coding-agent/src/bin/apply_patch": "patch launcher",
	};
	for (const [file, content] of Object.entries(assets)) {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), content);
	}
	fs.mkdirSync(path.join(root, "compiler", "lib"), { recursive: true });
	fs.writeFileSync(path.join(root, "compiler", "lib", "tsgo"), "compiler");
	return root;
}

function expectOldBuild(root: string, existing = true) {
	for (const directory of packageDirectories) {
		const dist = path.join(root, directory, "dist");
		expect(fs.existsSync(dist)).toBe(existing);
		if (existing) {
			expect(fs.readFileSync(path.join(dist, "settings-manager.js"), "utf8")).toBe("old settings");
			expect(fs.readFileSync(path.join(dist, "interactive-mode.js"), "utf8")).toBe("old interactive");
		}
	}
}

function expectNoStaging(root: string) {
	for (const directory of packageDirectories) {
		expect(fs.readdirSync(path.join(root, directory)).filter((name) => name.startsWith(".codeify-"))).toEqual([]);
	}
}

interface BuildOptions {
	existing?: boolean;
	compilerFailure?: { error?: Error; status?: number | null; signal?: string | null };
	failPromotion?: boolean;
	failAssetCopy?: boolean;
}

function runBuild(root: string, options: BuildOptions = {}) {
	const calls: string[] = [];
	const output = transformSync(source, {
		format: "cjs",
		define: {
			"import.meta.url": JSON.stringify(url.pathToFileURL(path.join(root, "scripts", "build-lowmem.mjs")).href),
		},
	}).code;
	vm.runInNewContext(output, {
		console: { log: vi.fn() },
		process: { platform: "linux", arch: "x64", env: {}, on: vi.fn(), off: vi.fn() },
		require: (specifier: string) => {
			switch (specifier) {
				case "node:child_process":
					return {
						spawnSync: (_command: string, args: string[], { cwd }: { cwd: string }) => {
							expectOldBuild(root, options.existing ?? true);
							calls.push(path.relative(root, cwd).split(path.sep).join("/"));
							const outDirIndex = args.indexOf("--outDir");
							expect(outDirIndex).toBeGreaterThan(-1);
							const outDir = args[outDirIndex + 1];
							expect(path.dirname(outDir)).toBe(cwd);
							expect(path.basename(outDir)).not.toBe("dist");
							const configPath = args[args.indexOf("-p") + 1];
							if (path.isAbsolute(configPath)) {
								const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
									compilerOptions: { paths: Record<string, string[]> };
								};
								for (const [name, targets] of Object.entries(config.compilerOptions.paths)) {
									if (!name.endsWith("/*")) {
										expect(targets[0]).toContain(".codeify-dist-");
										expect(fs.existsSync(targets[0])).toBe(true);
									}
								}
							}
							fs.writeFileSync(path.join(outDir, "index.d.ts"), "export {};");
							fs.writeFileSync(path.join(outDir, "settings-manager.js"), "new settings");
							if (cwd === path.join(root, "packages/coding-agent") && options.compilerFailure) {
								return options.compilerFailure;
							}
							fs.writeFileSync(path.join(outDir, "interactive-mode.js"), "new interactive");
							fs.writeFileSync(path.join(outDir, "cli.js"), "cli");
							fs.writeFileSync(path.join(outDir, "rpc-entry.js"), "rpc");
							return { status: 0, signal: null };
						},
					};
				case "node:fs":
					return {
						...fs,
						cpSync: (from: string, to: string, copyOptions: fs.CopySyncOptions) => {
							if (options.failAssetCopy && from.endsWith("template.html")) throw new Error("Asset copy failed");
							fs.cpSync(from, to, copyOptions);
						},
						renameSync: (from: string, to: string) => {
							if (
								options.failPromotion &&
								to === path.join(root, "packages/coding-agent/dist") &&
								!from.endsWith("-previous")
							) {
								throw new Error("Promotion failed");
							}
							fs.renameSync(from, to);
						},
					};
				case "node:module":
					return { createRequire: () => ({ resolve: () => path.join(root, "compiler", "package.json") }) };
				case "node:path":
					return path;
				case "node:url":
					return url;
				default:
					throw new Error(`Unexpected import: ${specifier}`);
			}
		},
	});
	return calls;
}

describe("low-memory build staging", () => {
	it.each([
		{ signal: "SIGINT", status: null },
		{ signal: "SIGKILL", status: null },
		{ status: 1 },
		{ error: new Error("Compiler could not start") },
	])("preserves every old package when compilation fails: %j", (compilerFailure) => {
		const root = createFixture();
		expect(() => runBuild(root, { compilerFailure })).toThrow();
		expectOldBuild(root);
		expectNoStaging(root);
		expect(fs.existsSync(path.join(root, "packages/ai/src/providers/data"))).toBe(false);
	});

	it("does not promote compiled files when copying assets fails", () => {
		const root = createFixture();
		expect(() => runBuild(root, { failAssetCopy: true })).toThrow("Asset copy failed");
		expectOldBuild(root);
		expectNoStaging(root);
	});

	it.each([true, false])("rolls back all packages after a failed promotion (existing: %s)", (existing) => {
		const root = createFixture(existing);
		expect(() => runBuild(root, { existing, failPromotion: true })).toThrow("Promotion failed");
		expectOldBuild(root, existing);
		expectNoStaging(root);
	});

	it.each([true, false])("promotes complete packages and assets together (existing: %s)", (existing) => {
		const root = createFixture(existing);
		expect(runBuild(root, { existing })).toEqual(packageDirectories);
		for (const directory of packageDirectories) {
			const dist = path.join(root, directory, "dist");
			expect(fs.readFileSync(path.join(dist, "settings-manager.js"), "utf8")).toBe("new settings");
			expect(fs.readFileSync(path.join(dist, "interactive-mode.js"), "utf8")).toBe("new interactive");
			expect(fs.existsSync(path.join(dist, "obsolete.js"))).toBe(false);
		}
		for (const file of [
			"packages/ai/dist/providers/data/test.json",
			"packages/storage/sqlite-node/dist/sqlite/migrations/001.sql",
			"packages/coding-agent/dist/modes/interactive/theme/dark.json",
			"packages/coding-agent/dist/modes/interactive/assets/header.png",
			"packages/coding-agent/dist/core/export-html/template.html",
			"packages/coding-agent/dist/core/export-html/vendor/highlight.js",
			"packages/coding-agent/dist/bin/apply_patch",
		]) {
			expect(fs.existsSync(path.join(root, file)), file).toBe(true);
		}
		expectNoStaging(root);
	});

	it("preserves existing model data when the build fails", () => {
		const root = createFixture();
		const dataDirectory = path.join(root, "packages/ai/src/providers/data");
		fs.mkdirSync(dataDirectory);
		fs.writeFileSync(path.join(dataDirectory, "test.json"), '{"model":"existing"}');
		expect(() => runBuild(root, { compilerFailure: { status: 1 } })).toThrow();
		expect(fs.readFileSync(path.join(dataDirectory, "test.json"), "utf8")).toBe('{"model":"existing"}');
	});
});
