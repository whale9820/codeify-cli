import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const source = readFileSync(new URL("../../../scripts/install.cjs", import.meta.url), "utf8");
const repairSource = source.slice(
	source.indexOf("function updateSourceCheckout()"),
	source.indexOf("function installWindowsArchive()"),
);

function git(directory: string, ...args: string[]): string {
	return execFileSync("git", ["-C", directory, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function createCheckout() {
	const directory = mkdtempSync(join(tmpdir(), "codeify-history-repair-"));
	directories.push(directory);
	const publisher = join(directory, "publisher");
	const remote = join(directory, "remote.git");
	const installed = join(directory, "installed");
	execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
	execFileSync("git", ["init", "--quiet", "--initial-branch=main", publisher]);
	git(publisher, "config", "user.name", "Installer test");
	git(publisher, "config", "user.email", "installer@example.invalid");
	writeFileSync(join(publisher, "source.txt"), "original source\n");
	writeFileSync(join(publisher, "package-lock.json"), '{"version":"1.0.0"}\n');
	git(publisher, "add", "source.txt", "package-lock.json");
	git(publisher, "commit", "--quiet", "-m", "original attribution");
	git(remote, "fetch", "--quiet", publisher, "refs/heads/main:refs/heads/main");
	execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${remote}`, installed]);
	return { publisher, remote, installed, originalHead: git(installed, "rev-parse", "HEAD") };
}

function rewriteHistory(checkout: ReturnType<typeof createCheckout>): void {
	git(checkout.publisher, "commit", "--quiet", "--amend", "-m", "removed attribution");
	writeFileSync(join(checkout.publisher, "source.txt"), "updated source\n");
	git(checkout.publisher, "add", "source.txt");
	git(checkout.publisher, "commit", "--quiet", "-m", "new feature");
	git(checkout.remote, "fetch", "--quiet", checkout.publisher, "+refs/heads/main:refs/heads/main");
}

function repair(installed: string): void {
	vm.runInNewContext(`${repairSource}\nupdateSourceCheckout();`, {
		console: { log: () => {} },
		cpSync,
		mkdirSync,
		mkdtempSync,
		join,
		installHome: installed,
		childEnv: process.env,
		execute: execFileSync,
		run: (command: string, args: string[]) =>
			execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
	});
}

afterEach(() => {
	while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("installer history repair", () => {
	it("repairs a shallow installation even after a previous failed pull fetched rewritten history", () => {
		const checkout = createCheckout();
		rewriteHistory(checkout);
		expect(() => git(checkout.installed, "pull", "--quiet", "--ff-only", "origin", "main")).toThrow();
		repair(checkout.installed);
		expect(git(checkout.installed, "rev-parse", "HEAD")).toBe(git(checkout.publisher, "rev-parse", "HEAD"));
		expect(readFileSync(join(checkout.installed, "source.txt"), "utf8")).toBe("updated source\n");
		expect(
			git(checkout.installed, "rev-parse", `codeify-before-history-repair-${checkout.originalHead.slice(0, 12)}`),
		).toBe(checkout.originalHead);
	});

	it("still fast-forwards ordinary updates", () => {
		const checkout = createCheckout();
		writeFileSync(join(checkout.publisher, "source.txt"), "normal update\n");
		git(checkout.publisher, "add", "source.txt");
		git(checkout.publisher, "commit", "--quiet", "-m", "normal update");
		git(checkout.remote, "fetch", "--quiet", checkout.publisher, "refs/heads/main:refs/heads/main");
		repair(checkout.installed);
		expect(readFileSync(join(checkout.installed, "source.txt"), "utf8")).toBe("normal update\n");
	});

	it.each([false, true])("backs up an npm lockfile rewrite before updating (rewritten history: %s)", (rewritten) => {
		const checkout = createCheckout();
		if (rewritten) rewriteHistory(checkout);
		else {
			writeFileSync(join(checkout.publisher, "package-lock.json"), '{"version":"1.0.1"}\n');
			git(checkout.publisher, "add", "package-lock.json");
			git(checkout.publisher, "commit", "--quiet", "-m", "update lockfile");
			git(checkout.remote, "fetch", "--quiet", checkout.publisher, "refs/heads/main:refs/heads/main");
		}
		const localLockfile = '{"version":"1.0.0","packages":{}}\n';
		writeFileSync(join(checkout.installed, "package-lock.json"), localLockfile);
		repair(checkout.installed);
		const backupRoot = join(checkout.installed, ".git", "codeify-install-backups");
		const backups = readdirSync(backupRoot);
		expect(backups).toHaveLength(1);
		expect(readFileSync(join(backupRoot, backups[0], "package-lock.json"), "utf8")).toBe(localLockfile);
		expect(readFileSync(join(checkout.installed, "package-lock.json"), "utf8")).toBe(
			readFileSync(join(checkout.publisher, "package-lock.json"), "utf8"),
		);
		expect(git(checkout.installed, "status", "--porcelain")).toBe("");
		expect(git(checkout.installed, "rev-parse", "HEAD")).toBe(git(checkout.publisher, "rev-parse", "HEAD"));
	});

	it.each(["staged", "deleted", "source", "untracked"])("preserves lockfile changes with %s changes", (change) => {
		const checkout = createCheckout();
		const lockfile = join(checkout.installed, "package-lock.json");
		writeFileSync(lockfile, "local lockfile\n");
		if (change === "staged") git(checkout.installed, "add", "package-lock.json");
		else if (change === "deleted") rmSync(lockfile);
		else writeFileSync(join(checkout.installed, change === "source" ? "source.txt" : "custom.txt"), "local work\n");
		const status = git(checkout.installed, "status", "--porcelain");
		expect(() => repair(checkout.installed)).toThrow("local changes");
		expect(git(checkout.installed, "status", "--porcelain")).toBe(status);
		expect(git(checkout.installed, "rev-parse", "HEAD")).toBe(checkout.originalHead);
		if (change !== "deleted") expect(readFileSync(lockfile, "utf8")).toBe("local lockfile\n");
	});

	it("leaves the lockfile untouched when its backup cannot be created", () => {
		const checkout = createCheckout();
		const lockfile = join(checkout.installed, "package-lock.json");
		writeFileSync(lockfile, "local lockfile\n");
		writeFileSync(join(checkout.installed, ".git", "codeify-install-backups"), "blocked\n");
		expect(() => repair(checkout.installed)).toThrow();
		expect(readFileSync(lockfile, "utf8")).toBe("local lockfile\n");
		expect(git(checkout.installed, "rev-parse", "HEAD")).toBe(checkout.originalHead);
	});

	it.each(["source.txt", "custom.txt"])("preserves local changes in %s", (file) => {
		const checkout = createCheckout();
		rewriteHistory(checkout);
		writeFileSync(join(checkout.installed, file), "local work\n");
		expect(() => repair(checkout.installed)).toThrow("local changes");
		expect(git(checkout.installed, "rev-parse", "HEAD")).toBe(checkout.originalHead);
		expect(readFileSync(join(checkout.installed, file), "utf8")).toBe("local work\n");
	});

	it("preserves divergent local commits", () => {
		const checkout = createCheckout();
		rewriteHistory(checkout);
		git(checkout.installed, "config", "user.name", "Installer test");
		git(checkout.installed, "config", "user.email", "installer@example.invalid");
		writeFileSync(join(checkout.installed, "source.txt"), "custom committed work\n");
		git(checkout.installed, "add", "source.txt");
		git(checkout.installed, "commit", "--quiet", "-m", "local work");
		const head = git(checkout.installed, "rev-parse", "HEAD");
		expect(() => repair(checkout.installed)).toThrow("diverged");
		expect(git(checkout.installed, "rev-parse", "HEAD")).toBe(head);
	});
});
