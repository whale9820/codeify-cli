#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getRuntimeCompilerInvocation } from "./runtime-compiler.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const providersDirectory = join(packageRoot, "src", "providers");
const dataDirectory = join(providersDirectory, "data");
const outputDirectory = join(packageRoot, "dist", "providers", "data");
const generatedRuntimeData = !existsSync(dataDirectory);

function run(command: string, args: string[]): void {
	const result = spawnSync(command, args, { cwd: packageRoot, env: process.env, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.signal) throw new Error(`${command} terminated by signal ${result.signal}`);
	if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
}

try {
	if (generatedRuntimeData) {
		mkdirSync(dataDirectory, { recursive: true });
		for (const file of readdirSync(providersDirectory).filter((entry) => entry.endsWith(".models.ts"))) {
			writeFileSync(join(dataDirectory, `${file.slice(0, -".models.ts".length)}.json`), "{}\n", "utf8");
		}
	}
	const compiler = getRuntimeCompilerInvocation();
	run(compiler.command, compiler.args);
	rmSync(outputDirectory, { recursive: true, force: true });
	cpSync(dataDirectory, outputDirectory, { recursive: true });
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	if (generatedRuntimeData) rmSync(dataDirectory, { recursive: true, force: true });
}
