#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(repoRoot, "package.json"));

function resolveTsgo() {
	const platformPackage = `@typescript/native-preview-${process.platform}-${process.arch}`;
	const packageJsonPath = require.resolve(`${platformPackage}/package.json`);
	const executable = join(dirname(packageJsonPath), "lib", process.platform === "win32" ? "tsgo.exe" : "tsgo");
	if (!existsSync(executable)) {
		throw new Error(`tsgo binary not found for this platform: ${executable}`);
	}
	return executable;
}

const tsgo = resolveTsgo();

const compilerEnv = {
	...process.env,
	GOGC: process.env.GOGC || "30",
	GOMEMLIMIT: process.env.GOMEMLIMIT || "512MiB",
};
const stagedDists = new Map();
let interruptedSignal;

function assertNotInterrupted() {
	if (interruptedSignal) {
		throw new Error(`Build interrupted by signal ${interruptedSignal}`);
	}
}

function compile(packageDirectory, stagedDependencies = {}) {
	const cwd = join(repoRoot, packageDirectory);
	const outputDirectory = mkdtempSync(join(cwd, ".codeify-dist-"));
	const configPath = join(cwd, `.codeify-tsconfig-${process.pid}-${Date.now()}.json`);
	try {
		assertNotInterrupted();
		let compilerConfigPath = "tsconfig.build.json";
		if (Object.keys(stagedDependencies).length > 0) {
			const compilerConfig = JSON.parse(readFileSync(join(cwd, "tsconfig.build.json"), "utf8"));
			const paths = { ...(compilerConfig.compilerOptions?.paths ?? {}) };
			for (const [packageName, stagedDirectory] of Object.entries(stagedDependencies)) {
				paths[packageName] = [join(stagedDirectory, "index.d.ts")];
				paths[`${packageName}/*`] = [
					join(stagedDirectory, "*.d.ts"),
					join(stagedDirectory, "api", "*.d.ts"),
					join(stagedDirectory, "components", "*.d.ts"),
					join(stagedDirectory, "providers", "*.d.ts"),
				];
			}
			compilerConfig.compilerOptions = { ...compilerConfig.compilerOptions, paths };
			writeFileSync(configPath, `${JSON.stringify(compilerConfig)}\n`, "utf8");
			compilerConfigPath = configPath;
		}
		const result = spawnSync(tsgo, ["-p", compilerConfigPath, "--noCheck", "--singleThreaded", "--outDir", outputDirectory], {
			cwd,
			env: compilerEnv,
			stdio: ["ignore", "inherit", "inherit"],
		});
		if (result.error) throw result.error;
		if (result.signal) {
			throw new Error(
				`Compiling ${packageDirectory} was terminated by signal ${result.signal}. This usually means the machine ran out of memory.`,
			);
		}
		if (result.status !== 0) {
			throw new Error(`Compiling ${packageDirectory} failed with status ${result.status}`);
		}
		assertNotInterrupted();
		stagedDists.set(packageDirectory, outputDirectory);
		return outputDirectory;
	} catch (error) {
		rmSync(outputDirectory, { force: true, recursive: true });
		throw error;
	} finally {
		rmSync(configPath, { force: true });
	}
}

function chmodExecutable(file) {
	if (process.platform !== "win32") chmodSync(file, 0o755);
}

function copyDirectory(from, destination, filter) {
	const source = join(repoRoot, from);
	if (!existsSync(source)) return;
	mkdirSync(destination, { recursive: true });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		if (entry.isDirectory()) continue;
		if (filter && !filter(entry.name)) continue;
		cpSync(join(source, entry.name), join(destination, entry.name));
	}
}

function commitStagedDists() {
	const replacements = [];
	try {
		for (const [packageDirectory, stagingDirectory] of stagedDists) {
			assertNotInterrupted();
			const packageRoot = join(repoRoot, packageDirectory);
			const target = join(packageRoot, "dist");
			const backup = `${stagingDirectory}-previous`;
			let oldDistMoved = false;
			try {
				if (existsSync(target)) {
					renameSync(target, backup);
					oldDistMoved = true;
				}
				renameSync(stagingDirectory, target);
				replacements.push({ backup, oldDistMoved, target });
			} catch (error) {
				if (oldDistMoved) {
					if (existsSync(target)) rmSync(target, { force: true, recursive: true });
					renameSync(backup, target);
				}
				throw error;
			}
		}
		assertNotInterrupted();
	} catch (error) {
		for (const replacement of replacements.reverse()) {
			if (existsSync(replacement.target)) rmSync(replacement.target, { force: true, recursive: true });
			if (replacement.oldDistMoved && existsSync(replacement.backup)) {
				renameSync(replacement.backup, replacement.target);
			}
		}
		throw error;
	}

	for (const replacement of replacements) {
		if (replacement.oldDistMoved) {
			rmSync(replacement.backup, { force: true, recursive: true });
		}
	}
}

const aiPackage = join(repoRoot, "packages", "ai");
const providersDirectory = join(aiPackage, "src", "providers");
const dataDirectory = join(providersDirectory, "data");
const generatedRuntimeData = !existsSync(dataDirectory);
const interruptSignals = ["SIGINT", "SIGTERM"];
const onInterrupt = (signal) => {
	interruptedSignal = signal;
};

console.log("Building Codeify CLI in low-memory mode");

for (const signal of interruptSignals) process.on(signal, onInterrupt);
try {
	const tuiDist = compile("packages/tui");
	if (generatedRuntimeData) {
		mkdirSync(dataDirectory, { recursive: true });
		for (const file of readdirSync(providersDirectory).filter((entry) => entry.endsWith(".models.ts"))) {
			writeFileSync(join(dataDirectory, `${file.slice(0, -".models.ts".length)}.json`), "{}\n", "utf8");
		}
	}
	const aiDist = compile("packages/ai");
	cpSync(dataDirectory, join(aiDist, "providers", "data"), { recursive: true });
	const agentDist = compile("packages/agent", { "codeify-ai": aiDist });
	const storageDist = compile("packages/storage/sqlite-node", {
		"codeify-agent-core": agentDist,
		"codeify-ai": aiDist,
	});
	cpSync(
		join(repoRoot, "packages/storage/sqlite-node/src/sqlite/migrations"),
		join(storageDist, "sqlite", "migrations"),
		{ recursive: true },
	);
	const codingAgent = "packages/coding-agent";
	const codingAgentDist = compile(codingAgent, {
		"codeify-agent-core": agentDist,
		"codeify-ai": aiDist,
		"codeify-tui": tuiDist,
	});
	copyDirectory(
		`${codingAgent}/src/modes/interactive/theme`,
		join(codingAgentDist, "modes", "interactive", "theme"),
		(name) => name.endsWith(".json"),
	);
	copyDirectory(
		`${codingAgent}/src/modes/interactive/assets`,
		join(codingAgentDist, "modes", "interactive", "assets"),
		(name) => name.endsWith(".png"),
	);
	copyDirectory(
		`${codingAgent}/src/core/export-html`,
		join(codingAgentDist, "core", "export-html"),
		(name) => ["template.html", "template.css", "template.js"].includes(name),
	);
	copyDirectory(
		`${codingAgent}/src/core/export-html/vendor`,
		join(codingAgentDist, "core", "export-html", "vendor"),
		(name) => name.endsWith(".js"),
	);
	copyDirectory(`${codingAgent}/src/bin`, join(codingAgentDist, "bin"));
	const serverDist = compile("packages/server", {
		"codeify-coding-agent": codingAgentDist,
		"codeify-agent-core": agentDist,
		"codeify-ai": aiDist,
		"codeify-tui": tuiDist,
		"codeify-storage-sqlite-node": storageDist,
	});
	chmodExecutable(join(codingAgentDist, "cli.js"));
	chmodExecutable(join(codingAgentDist, "rpc-entry.js"));
	chmodExecutable(join(serverDist, "cli.js"));
	commitStagedDists();
} finally {
	if (generatedRuntimeData) rmSync(dataDirectory, { recursive: true, force: true });
	for (const stagingDirectory of stagedDists.values()) {
		rmSync(stagingDirectory, { force: true, recursive: true });
	}
	for (const signal of interruptSignals) process.off(signal, onInterrupt);
}

console.log("Low-memory build complete");
