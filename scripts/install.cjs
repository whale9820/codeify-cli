const { execFileSync } = require("node:child_process");
const { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { delimiter, dirname, join } = require("node:path");

const isWindows = process.platform === "win32";
const [major, minor] = process.versions.node.split(".").map(Number);

if (major < 22 || (major === 22 && minor < 19)) {
	throw new Error(`Node.js 22.19 or newer is required. Found ${process.versions.node}.`);
}

const repository = process.env.CODEIFY_INSTALL_REPOSITORY || "https://github.com/whale9820/codeify-cli.git";
const installHome =
	process.env.CODEIFY_INSTALL_HOME ||
	(isWindows
		? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "CodeifyCLI")
		: join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "codeify-cli"));
const binDirectory =
	process.env.CODEIFY_INSTALL_BIN ||
	(isWindows
		? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Codeify", "bin")
		: process.env.XDG_BIN_HOME || join(homedir(), ".local", "bin"));
const npmCommand = isWindows ? "npm.cmd" : "npm";

function verifyCommand(command, args, message) {
	try {
		execFileSync(command, args, { stdio: "ignore" });
	} catch {
		throw new Error(message);
	}
}

function run(command, args, cwd) {
	console.log(`> ${command} ${args.join(" ")}`);
	execFileSync(command, args, { cwd, env: process.env, stdio: "inherit" });
}

verifyCommand("git", ["--version"], "Git is required.");
verifyCommand(npmCommand, ["--version"], "npm is required.");

if (existsSync(join(installHome, ".git"))) {
	run("git", ["-C", installHome, "pull", "--ff-only"]);
} else if (existsSync(installHome)) {
	throw new Error(`${installHome} already exists and is not a Git checkout.`);
} else {
	mkdirSync(dirname(installHome), { recursive: true });
	run("git", ["clone", "--depth", "1", repository, installHome]);
}

run(npmCommand, ["--prefix", installHome, "ci", "--ignore-scripts"]);
run(npmCommand, ["--prefix", installHome, "run", "build:offline"]);

const cliPath = join(installHome, "packages", "coding-agent", "dist", "cli.js");
mkdirSync(binDirectory, { recursive: true });

if (isWindows) {
	const launcherPath = join(binDirectory, "codeify.cmd");
	writeFileSync(launcherPath, `@echo off\r\nnode.exe "${cliPath}" %*\r\n`, "ascii");
	const powershell = [
		"$bin=$env:CODEIFY_INSTALL_BIN",
		"$current=[Environment]::GetEnvironmentVariable('Path','User')",
		"$entries=@($current -split ';' | Where-Object { $_ })",
		"if ($entries -notcontains $bin) { [Environment]::SetEnvironmentVariable('Path', ((@($entries) + $bin) -join ';'), 'User') }",
	].join("; ");
	execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", powershell], {
		env: { ...process.env, CODEIFY_INSTALL_BIN: binDirectory },
		stdio: "inherit",
	});
} else {
	const launcherPath = join(binDirectory, "codeify");
	if (existsSync(launcherPath)) {
		if (lstatSync(launcherPath).isDirectory()) {
			throw new Error(`${launcherPath} is a directory and cannot be replaced.`);
		}
		rmSync(launcherPath, { force: true });
	}
	chmodSync(cliPath, 0o755);
	symlinkSync(cliPath, launcherPath);
}

run(process.execPath, [cliPath, "--version"]);

const pathEntries = (process.env.PATH || "").split(delimiter);
if (!pathEntries.includes(binDirectory)) {
	console.log(`Add ${binDirectory} to PATH, then open a new terminal.`);
}
console.log("Codeify CLI installed. Run: codeify");
