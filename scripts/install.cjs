const { execFileSync } = require("node:child_process");
const {
	accessSync,
	chmodSync,
	constants,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} = require("node:fs");
const { homedir, totalmem } = require("node:os");
const { delimiter, dirname, isAbsolute, join } = require("node:path");

const isWindows = process.platform === "win32";
const [major, minor] = process.versions.node.split(".").map(Number);

if (major < 22 || (major === 22 && minor < 19)) {
	throw new Error(`Node.js 22.19 or newer is required. Found ${process.versions.node}.`);
}

const repository = process.env.CODEIFY_INSTALL_REPOSITORY || "https://github.com/whale9820/codeify-cli.git";
const sourceArchive =
	process.env.CODEIFY_INSTALL_ARCHIVE || `${repository.replace(/\.git$/u, "")}/archive/refs/heads/main.zip`;
const installHome =
	process.env.CODEIFY_INSTALL_HOME ||
	(isWindows
		? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "CodeifyCLI")
		: join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "codeify-cli"));
const pathEntries = (process.env.PATH || "").split(delimiter).filter(Boolean);

function canInstallTo(directory) {
	try {
		accessSync(existsSync(directory) ? directory : dirname(directory), constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

function defaultBinDirectory() {
	if (isWindows) {
		return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Codeify", "bin");
	}
	const homeBin = join(homedir(), ".local", "bin");
	const candidates = [process.env.XDG_BIN_HOME, homeBin, join(homedir(), "bin"), "/usr/local/bin", ...pathEntries].filter(Boolean);
	return candidates.find((directory) => isAbsolute(directory) && pathEntries.includes(directory) && canInstallTo(directory)) || homeBin;
}

const binDirectory = process.env.CODEIFY_INSTALL_BIN || defaultBinDirectory();
const npmCommand = isWindows ? "npm.cmd" : "npm";
const LOW_MEMORY_THRESHOLD_BYTES = 2.5 * 1024 * 1024 * 1024;
const forcedLowMemory = process.env.CODEIFY_INSTALL_LOW_MEMORY;
const detectedMemoryBytes = typeof totalmem === "function" ? totalmem() : 0;
const lowMemory =
	forcedLowMemory === "1"
		? true
		: forcedLowMemory === "0"
			? false
			: detectedMemoryBytes > 0 && detectedMemoryBytes < LOW_MEMORY_THRESHOLD_BYTES;
const childEnv = {
	...process.env,
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "",
	SSH_ASKPASS: "",
	npm_config_audit: "false",
	npm_config_fund: "false",
	npm_config_progress: "false",
};

function execute(command, args, options) {
	if (isWindows && command.endsWith(".cmd")) {
		return execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", [command, ...args].join(" ")], options);
	}
	return execFileSync(command, args, options);
}

function commandAvailable(command, args) {
	try {
		execute(command, args, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function verifyCommand(command, args, message) {
	if (!commandAvailable(command, args)) {
		throw new Error(message);
	}
}

function run(command, args, cwd, silent = false, extraEnv) {
	const options = {
		cwd,
		encoding: "utf8",
		env: extraEnv ? { ...childEnv, ...extraEnv } : childEnv,
		stdio: silent ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
	};
	if (silent) {
		options.maxBuffer = 50 * 1024 * 1024;
	}
	try {
		return execute(command, args, options);
	} catch (error) {
		if (silent && error && typeof error === "object") {
			if (error.stdout) process.stderr.write(String(error.stdout));
			if (error.stderr) process.stderr.write(String(error.stderr));
		}
		if (error && typeof error === "object" && (error.signal === "SIGKILL" || error.signal === "SIGTERM")) {
			throw new Error(
				`${command} was killed by the operating system (${error.signal}), which almost always means it ran out of memory.\n` +
					"Add swap space and retry, for example:\n" +
					"  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile",
			);
		}
		throw error;
	}
}

function step(number, message) {
	console.log(`[${number}/4] ${message}`);
}

function installWindowsArchive() {
	mkdirSync(dirname(installHome), { recursive: true });
	const temporaryDirectory = mkdtempSync(join(dirname(installHome), "codeify-download-"));
	const archivePath = join(temporaryDirectory, "source.zip");
	const extractDirectory = join(temporaryDirectory, "source");
	mkdirSync(extractDirectory, { recursive: true });
	try {
		const downloadScript =
			'const{writeFile}=require("node:fs/promises");fetch(process.env.CODEIFY_SOURCE_ARCHIVE).then(r=>r.ok?r.arrayBuffer():Promise.reject(Error("Source download failed: "+r.status))).then(b=>writeFile(process.env.CODEIFY_SOURCE_PATH,Buffer.from(b)))';
		execute(process.execPath, ["-e", downloadScript], {
			env: { ...childEnv, CODEIFY_SOURCE_ARCHIVE: sourceArchive, CODEIFY_SOURCE_PATH: archivePath },
			stdio: "inherit",
		});
		const powershell = [
			"$ErrorActionPreference='Stop'",
			"Expand-Archive -LiteralPath $env:CODEIFY_SOURCE_PATH -DestinationPath $env:CODEIFY_SOURCE_DESTINATION -Force",
		].join("; ");
		execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", powershell], {
			env: {
				...process.env,
				CODEIFY_SOURCE_DESTINATION: extractDirectory,
				CODEIFY_SOURCE_PATH: archivePath,
			},
			stdio: "inherit",
		});
		const sourceDirectories = readdirSync(extractDirectory)
			.map((entry) => join(extractDirectory, entry))
			.filter((entry) => statSync(entry).isDirectory());
		if (sourceDirectories.length !== 1) {
			throw new Error("Downloaded source archive has an unexpected structure.");
		}
		mkdirSync(installHome, { recursive: true });
		cpSync(sourceDirectories[0], installHome, { force: true, recursive: true });
		writeFileSync(join(installHome, ".codeify-archive-install"), "", "ascii");
	} finally {
		rmSync(temporaryDirectory, { force: true, recursive: true });
	}
}

const gitAvailable = commandAvailable("git", ["--version"]);
verifyCommand(npmCommand, ["--version"], "npm is required.");

const existingCheckout = existsSync(join(installHome, ".git"));
const existingArchiveInstall = existsSync(join(installHome, ".codeify-archive-install"));
const updatingExisting = existingCheckout || existingArchiveInstall;

console.log("Codeify CLI");
console.log("");
step(1, updatingExisting ? "Updating source" : "Downloading source");

if (existingCheckout) {
	if (!gitAvailable) {
		throw new Error("Git is required to update this existing Git-based installation.");
	}
	run("git", ["-C", installHome, "pull", "--ff-only"]);
} else if (existingArchiveInstall) {
	if (!isWindows) {
		throw new Error("Git is required to update this installation.");
	}
	installWindowsArchive();
} else if (existsSync(installHome)) {
	throw new Error(`${installHome} already exists and is not a Codeify CLI installation.`);
} else if (gitAvailable) {
	mkdirSync(dirname(installHome), { recursive: true });
	run("git", ["clone", "--depth", "1", repository, installHome]);
} else if (isWindows) {
	installWindowsArchive();
} else {
	throw new Error("Git is required.");
}

step(2, "Installing dependencies");
run(
	npmCommand,
	[updatingExisting && isWindows ? "install" : "ci", "--ignore-scripts"],
	installHome,
	false,
	lowMemory ? { NODE_OPTIONS: "--max-old-space-size=256", npm_config_maxsockets: "3" } : undefined,
);
if (lowMemory) {
	const gigabytes = (detectedMemoryBytes / (1024 * 1024 * 1024)).toFixed(1);
	step(3, `Building Codeify CLI (low-memory mode, ${gigabytes} GB detected)`);
	run(process.execPath, [join(installHome, "scripts", "build-lowmem.mjs")], installHome);
} else {
	step(3, "Building Codeify CLI");
	run(npmCommand, ["run", "build:runtime"], installHome);
}

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

const version = run(process.execPath, [cliPath, "--version"], installHome, true).trim();

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
