import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function getRuntimeCompilerInvocation(
	nodeExecutable = process.execPath,
	packageJsonUrl = import.meta.resolve("@typescript/native-preview/package.json"),
): { command: string; args: string[] } {
	return {
		command: nodeExecutable,
		args: [join(dirname(fileURLToPath(packageJsonUrl)), "bin", "tsgo.js"), "-p", "tsconfig.build.json"],
	};
}
