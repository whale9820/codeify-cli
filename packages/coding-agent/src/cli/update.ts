import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../config.ts";

export const CODEIFY_INSTALLER_URL = "https://codeify.cc/install.cjs";
export const CODEIFY_VERSION_URL =
	"https://api.github.com/repos/whale9820/codeify-cli/contents/packages/coding-agent/package.json?ref=main";

export interface CodeifyUpdateOptions {
	installerUrl?: string;
	versionUrl?: string;
	currentVersion?: string;
	fetchImpl?: typeof globalThis.fetch;
	nodeExecutable?: string;
	env?: NodeJS.ProcessEnv;
}

export function isCodeifyUpdateCommand(args: readonly string[]): boolean {
	return args.length === 1 && args[0] === "update";
}

async function fetchCloudVersion(fetchImpl: typeof globalThis.fetch, versionUrl: string): Promise<string> {
	const response = await fetchImpl(versionUrl, {
		headers: { accept: "application/vnd.github.raw", "cache-control": "no-cache" },
		redirect: "follow",
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		throw new Error(`Version check failed: HTTP ${response.status}`);
	}
	let manifest: unknown;
	try {
		manifest = await response.json();
	} catch {
		throw new Error("Version check returned invalid JSON");
	}
	const version =
		manifest && typeof manifest === "object" && "version" in manifest ? Reflect.get(manifest, "version") : undefined;
	if (typeof version !== "string" || version.trim().length === 0) {
		throw new Error("Version check returned no version");
	}
	return version.trim();
}

export async function runCodeifyUpdate(options: CodeifyUpdateOptions = {}): Promise<void> {
	const installerUrl = options.installerUrl ?? CODEIFY_INSTALLER_URL;
	const versionUrl = options.versionUrl ?? CODEIFY_VERSION_URL;
	const currentVersion = options.currentVersion ?? VERSION;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const cloudVersion = await fetchCloudVersion(fetchImpl, versionUrl);
	if (cloudVersion === currentVersion) {
		console.log(`Codeify CLI ${currentVersion} is already up to date.`);
		return;
	}
	console.log(`Updating Codeify CLI ${currentVersion} to ${cloudVersion}.`);
	const response = await fetchImpl(installerUrl, {
		redirect: "follow",
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		throw new Error(`Installer download failed: HTTP ${response.status}`);
	}
	const installer = await response.text();
	if (installer.trim().length === 0) {
		throw new Error("Installer download returned an empty response");
	}

	const directory = await mkdtemp(join(tmpdir(), "codeify-update-"));
	const installerPath = join(directory, "install.cjs");
	try {
		await writeFile(installerPath, installer, { encoding: "utf8", mode: 0o600 });
		const result = spawnSync(options.nodeExecutable ?? "node", [installerPath], {
			env: options.env ?? process.env,
			stdio: "inherit",
		});
		if (result.error) {
			throw new Error(`Unable to start the installer: ${result.error.message}`);
		}
		if (result.signal) {
			throw new Error(`Installer terminated by signal ${result.signal}`);
		}
		if (result.status !== 0) {
			throw new Error(`Installer exited with status ${result.status ?? "unknown"}`);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

export interface CodeifyUpdateInfo {
	current: string;
	latest: string;
}

export function isNewerVersion(latest: string, current: string): boolean {
	const parse = (version: string): number[] => {
		const core = version.trim().replace(/^v/u, "").split("-")[0] ?? "";
		return core.split(".").map((part) => Number.parseInt(part, 10) || 0);
	};
	const latestParts = parse(latest);
	const currentParts = parse(current);
	const length = Math.max(latestParts.length, currentParts.length);
	for (let i = 0; i < length; i++) {
		const latestPart = latestParts[i] ?? 0;
		const currentPart = currentParts[i] ?? 0;
		if (latestPart !== currentPart) return latestPart > currentPart;
	}
	return false;
}

export async function checkForCodeifyUpdate(
	options: CodeifyUpdateOptions = {},
): Promise<CodeifyUpdateInfo | undefined> {
	const versionUrl = options.versionUrl ?? CODEIFY_VERSION_URL;
	const currentVersion = options.currentVersion ?? VERSION;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	try {
		const latest = await fetchCloudVersion(fetchImpl, versionUrl);
		return isNewerVersion(latest, currentVersion) ? { current: currentVersion, latest } : undefined;
	} catch {
		return undefined;
	}
}
