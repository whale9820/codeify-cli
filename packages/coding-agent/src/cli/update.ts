import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CODEIFY_INSTALLER_URL = "https://codeify.cc/install.cjs";

export interface CodeifyUpdateOptions {
	installerUrl?: string;
	fetchImpl?: typeof globalThis.fetch;
	nodeExecutable?: string;
	env?: NodeJS.ProcessEnv;
}

export function isCodeifyUpdateCommand(args: readonly string[]): boolean {
	return args.length === 1 && args[0] === "update";
}

export async function runCodeifyUpdate(options: CodeifyUpdateOptions = {}): Promise<void> {
	const installerUrl = options.installerUrl ?? CODEIFY_INSTALLER_URL;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	console.log(`Downloading Codeify installer from ${installerUrl}`);
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
