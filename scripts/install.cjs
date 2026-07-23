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
	try {
		return execFileSync(command, args, {
			cwd,
			encoding: "utf8",
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		if (error && typeof error === "object") {
			if (error.stdout) process.stderr.write(String(error.stdout));
			if (error.stderr) process.stderr.write(String(error.stderr));
		}
		throw error;
	}
}

function step(number, message) {
	console.log(`[${number}/4] ${message}`);
}

verifyCommand("git", ["--version"], "Git is required.");
verifyCommand(npmCommand, ["--version"], "npm is required.");

const existingCheckout = existsSync(join(installHome, ".git"));

console.log("Codeify CLI");
console.log("");
step(1, existingCheckout ? "Updating source" : "Downloading source");

if (existingCheckout) {
	run("git", ["-C", installHome, "pull", "--ff-only"]);
} else if (existsSync(installHome)) {
	throw new Error(`${installHome} already exists and is not a Git checkout.`);
} else {
	mkdirSync(dirname(installHome), { recursive: true });
	run("git", ["clone", "--depth", "1", repository, installHome]);
}

step(2, "Installing dependencies");
run(npmCommand, ["ci", "--ignore-scripts"], installHome);
step(3, "Building Codeify CLI");
run(npmCommand, ["run", "build:runtime"], installHome);

const cliPath = join(installHome, "packages", "coding-agent", "dist", "cli.js");
step(4, "Creating the codeify command");
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

const version = run(process.execPath, [cliPath, "--version"]).trim();

const pathEntries = (process.env.PATH || "").split(delimiter);
console.log("");
console.log(`Codeify CLI ${version} installed successfully.`);
if (!pathEntries.includes(binDirectory)) {
	if (isWindows) {
		console.log("Restart your terminal, then run: codeify");
	} else {
		console.log(`Add ${binDirectory} to PATH, then run: codeify`);
	}
} else {
	console.log("Run: codeify");
}
