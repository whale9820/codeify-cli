import { describe, expect, it } from "vitest";
import { getRuntimeCompilerInvocation } from "../scripts/runtime-compiler.ts";

describe("runtime compiler invocation", () => {
	it("runs the TypeScript compiler JavaScript entry point through Node", () => {
		const invocation = getRuntimeCompilerInvocation(
			"C:\\Program Files\\nodejs\\node.exe",
			"file:///C:/source/codeify/node_modules/@typescript/native-preview/package.json",
		);

		expect(invocation.command).toBe("C:\\Program Files\\nodejs\\node.exe");
		expect(invocation.args[0]?.replaceAll("\\", "/")).toMatch(/\/bin\/tsgo\.js$/);
		expect(invocation.args).toEqual([invocation.args[0], "-p", "tsconfig.build.json"]);
		expect(invocation.args.join(" ")).not.toContain("tsgo.cmd");
	});
});
