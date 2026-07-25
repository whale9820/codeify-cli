#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
};

function compile(packageDirectory) {
	const cwd = join(repoRoot, packageDirectory);
	const result = spawnSync(tsgo, ["-p", "tsconfig.build.json", "--noCheck"], {
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
}

function chmodExecutable(file) {
	if (process.platform === "win32") return;
	const path = join(repoRoot, file);
	if (existsSync(path)) {
		spawnSync("chmod", ["+x", path], { stdio: "ignore" });
	}
}

function copyDirectory(from, to, filter) {
	const source = join(repoRoot, from);
	if (!existsSync(source)) return;
	const destination = join(repoRoot, to);
	mkdirSync(destination, { recursive: true });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		if (entry.isDirectory()) continue;
		if (filter && !filter(entry.name)) continue;
		cpSync(join(source, entry.name), join(destination, entry.name));
	}
}

const aiPackage = join(repoRoot, "packages", "ai");
const providersDirectory = join(aiPackage, "src", "providers");
const dataDirectory = join(providersDirectory, "data");
const runtimeDataOutput = join(aiPackage, "dist", "providers", "data");
const generatedRuntimeData = !existsSync(dataDirectory);

console.log("Building Codeify CLI in low-memory mode");

compile("packages/tui");

try {
	if (generatedRuntimeData) {
		mkdirSync(dataDirectory, { recursive: true });
		for (const file of readdirSync(providersDirectory).filter((entry) => entry.endsWith(".models.ts"))) {
			writeFileSync(join(dataDirectory, `${file.slice(0, -".models.ts".length)}.json`), "{}\n", "utf8");
		}
	}
	compile("packages/ai");
	rmSync(runtimeDataOutput, { recursive: true, force: true });
	cpSync(dataDirectory, runtimeDataOutput, { recursive: true });
} finally {
	if (generatedRuntimeData) rmSync(dataDirectory, { recursive: true, force: true });
}

compile("packages/agent");

compile("packages/storage/sqlite-node");
cpSync(
	join(repoRoot, "packages/storage/sqlite-node/src/sqlite/migrations"),
	join(repoRoot, "packages/storage/sqlite-node/dist/sqlite/migrations"),
	{ recursive: true },
);

compile("packages/coding-agent");
chmodExecutable("packages/coding-agent/dist/cli.js");
chmodExecutable("packages/coding-agent/dist/rpc-entry.js");

const codingAgent = "packages/coding-agent";
copyDirectory(
	`${codingAgent}/src/modes/interactive/theme`,
	`${codingAgent}/dist/modes/interactive/theme`,
	(name) => name.endsWith(".json"),
);
copyDirectory(
	`${codingAgent}/src/modes/interactive/assets`,
	`${codingAgent}/dist/modes/interactive/assets`,
	(name) => name.endsWith(".png"),
);
copyDirectory(`${codingAgent}/src/core/export-html`, `${codingAgent}/dist/core/export-html`, (name) =>
	["template.html", "template.css", "template.js"].includes(name),
);
copyDirectory(
	`${codingAgent}/src/core/export-html/vendor`,
	`${codingAgent}/dist/core/export-html/vendor`,
	(name) => name.endsWith(".js"),
);

compile("packages/server");
chmodExecutable("packages/server/dist/cli.js");

console.log("Low-memory build complete");
