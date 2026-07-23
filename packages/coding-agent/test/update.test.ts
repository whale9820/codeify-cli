import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODEIFY_INSTALLER_URL, isCodeifyUpdateCommand, runCodeifyUpdate } from "../src/cli/update.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function serve(status: number, body: string): Promise<{ close: () => Promise<void>; url: string }> {
	const server = createServer((_request, response) => {
		response.writeHead(status, { "content-type": "application/javascript" });
		response.end(body);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Test server did not bind to a TCP port");
	}
	return {
		url: `http://127.0.0.1:${address.port}/install.cjs`,
		close: async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
	};
}

describe("Codeify updater", () => {
	it("recognizes only the standalone update command", () => {
		expect(isCodeifyUpdateCommand(["update"])).toBe(true);
		expect(isCodeifyUpdateCommand(["update", "dependencies"])).toBe(false);
		expect(isCodeifyUpdateCommand(["--print", "update"])).toBe(false);
	});

	it("uses the hosted Codeify installer by default", () => {
		expect(CODEIFY_INSTALLER_URL).toBe("https://codeify.cc/install.cjs");
	});

	it("downloads and executes the installer", async () => {
		const directory = await mkdtemp(join(tmpdir(), "codeify-update-test-"));
		directories.push(directory);
		const marker = join(directory, "updated.txt");
		const hosted = await serve(
			200,
			`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "updated", "utf8");`,
		);
		try {
			await runCodeifyUpdate({ installerUrl: hosted.url });
		} finally {
			await hosted.close();
		}
		expect(await readFile(marker, "utf8")).toBe("updated");
	});

	it("rejects failed installer downloads", async () => {
		const hosted = await serve(503, "unavailable");
		try {
			await expect(runCodeifyUpdate({ installerUrl: hosted.url })).rejects.toThrow(
				"Installer download failed: HTTP 503",
			);
		} finally {
			await hosted.close();
		}
	});
});
