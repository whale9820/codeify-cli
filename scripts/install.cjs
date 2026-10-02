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
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} = require("node:fs");
const { homedir, tmpdir, totalmem } = require("node:os");
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
const minimalInstall = forcedLowMemory !== "0";
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

const verbose = process.env.CODEIFY_INSTALL_VERBOSE === "1";
const quietStdio = verbose ? "inherit" : ["ignore", "ignore", "inherit"];

function run(command, args, cwd, forceSilent = false, extraEnv) {
	const silent = forceSilent || !verbose;
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
		if (
			error &&
			typeof error === "object" &&
			[error.message, error.stdout, error.stderr].some((value) => /ENOSPC|no space left on device/i.test(String(value ?? "")))
		) {
			throw new Error(`${command} ran out of disk space. Free disk space and retry.`);
		}
		throw error;
	}
}

const interactive = Boolean(process.stdout.isTTY) && !verbose;

function formatDuration(milliseconds) {
	return `${(milliseconds / 1000).toFixed(1)}s`;
}

function task(runningLabel, doneLabel, action) {
	const started = Date.now();
	if (verbose) console.log(`${runningLabel}...`);
	else if (interactive) process.stdout.write(`  ${runningLabel}...`);
	try {
		const result = action();
		const line = `  \u2713 ${doneLabel.padEnd(28)} ${formatDuration(Date.now() - started)}`;
		if (interactive) process.stdout.write(`\r\x1b[2K${line}\n`);
		else console.log(line);
		return result;
	} catch (error) {
		if (interactive) process.stdout.write(`\r\x1b[2K  \u2717 ${runningLabel}\n`);
		throw error;
	}
}

function installBuildCompiler() {
	const compilerDirectory = mkdtempSync(join(tmpdir(), "codeify-compiler-"));
	try {
		const packageJson = JSON.parse(readFileSync(join(installHome, "package.json"), "utf8"));
		const compilerVersion = packageJson.devDependencies?.["@typescript/native-preview"];
		if (typeof compilerVersion !== "string" || compilerVersion.length === 0) {
			throw new Error("The source checkout does not declare the TypeScript compiler version.");
		}
		writeFileSync(
			join(compilerDirectory, "package.json"),
			`${JSON.stringify(
				{ private: true, dependencies: { "@typescript/native-preview": compilerVersion } },
				null,
			"\t",
			)}\n`,
			"utf8",
		);
		run(
			npmCommand,
			[
				"install",
				"--omit=dev",
				"--ignore-scripts",
				"--no-save",
				"--package-lock=false",
				`@typescript/native-preview@${compilerVersion}`,
			],
			compilerDirectory,
		);
		return compilerDirectory;
	} catch (error) {
		rmSync(compilerDirectory, { force: true, recursive: true });
		throw error;
	}
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
			stdio: quietStdio,
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
			stdio: quietStdio,
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
const freshInstall = !updatingExisting && !existsSync(installHome);
const completionPath = join(installHome, ".codeify-install-complete");
let installSucceeded = false;

try {
console.log("Codeify CLI");
console.log("");
if (updatingExisting) rmSync(completionPath, { force: true });

task(updatingExisting ? "Updating source" : "Downloading source", updatingExisting ? "Updated source" : "Downloaded source", () => {
	if (existingCheckout) {
		if (!gitAvailable) {
			throw new Error("Git is required to update this existing Git-based installation.");
		}
		if (!isWindows) {
			rmSync(join(installHome, "node_modules"), { force: true, recursive: true });
		}
		run("git", ["-C", installHome, "pull", "--quiet", "--ff-only", "origin", "main"]);
	} else if (existingArchiveInstall) {
		if (!isWindows) {
			throw new Error("Git is required to update this installation.");
		}
		installWindowsArchive();
	} else if (existsSync(installHome)) {
		throw new Error(`${installHome} already exists and is not a Codeify CLI installation.`);
	} else if (gitAvailable) {
		mkdirSync(dirname(installHome), { recursive: true });
		run("git", ["clone", "--quiet", "--depth", "1", repository, installHome]);
	} else if (isWindows) {
		installWindowsArchive();
	} else {
		throw new Error("Git is required.");
	}
});

task("Installing dependencies", "Installed dependencies", () =>
	run(
		npmCommand,
		[
			updatingExisting && isWindows ? "install" : "ci",
			...(minimalInstall ? ["--omit=dev"] : []),
			"--ignore-scripts",
			"--loglevel=error",
		],
		installHome,
		false,
		lowMemory ? { NODE_OPTIONS: "--max-old-space-size=256", npm_config_maxsockets: "3" } : undefined,
	),
);

task("Building Codeify CLI", "Built Codeify CLI", () => {
	let compilerDirectory;
	try {
		if (minimalInstall) {
			compilerDirectory = installBuildCompiler();
			const nodePath = [join(compilerDirectory, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(delimiter);
			run(process.execPath, [join(installHome, "scripts", "build-lowmem.mjs")], installHome, false, {
				NODE_PATH: nodePath,
			});
		} else {
			run(npmCommand, ["run", "build:runtime", "--silent"], installHome);
		}
	} finally {
		if (compilerDirectory) {
			rmSync(compilerDirectory, { force: true, recursive: true });
		}
	}
});

const cliPath = join(installHome, "packages", "coding-agent", "dist", "cli.js");
task("Creating the codeify command", "Created the codeify command", () => {
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
			stdio: quietStdio,
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
});

const version = run(process.execPath, [cliPath, "--version"], installHome, true).trim();
writeFileSync(completionPath, `${version}\n`, "utf8");

console.log("");
console.log(`Codeify CLI ${version} is ready.`);
if (!pathEntries.includes(binDirectory)) {
	if (isWindows) {
		console.log("Restart your terminal, then run: codeify");
	} else {
		console.log(`Add ${binDirectory} to PATH, then run: codeify`);
	}
} else {
	console.log("Run: codeify");
}

installSucceeded = true;
} catch (error) {
	if (freshInstall && !installSucceeded) {
		rmSync(installHome, { force: true, recursive: true });
	}
	throw error;
}
