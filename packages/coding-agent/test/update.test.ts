import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CODEIFY_INSTALLER_URL,
	CODEIFY_VERSION_URL,
	isCodeifyUpdateCommand,
	runCodeifyUpdate,
} from "../src/cli/update.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface HostedRoute {
	body: string;
	contentType: string;
	status: number;
}

async function serve(routes: Record<string, HostedRoute>): Promise<{
	baseUrl: string;
	close: () => Promise<void>;
	requests: string[];
}> {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		const path = request.url ?? "/";
		requests.push(path);
		const route = routes[path];
		if (!route) {
			response.writeHead(404);
			response.end("not found");
			return;
		}
		response.writeHead(route.status, { "content-type": route.contentType });
		response.end(route.body);
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
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
		requests,
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
		expect(CODEIFY_VERSION_URL).toBe(
			"https://raw.githubusercontent.com/whale9820/codeify-cli/main/packages/coding-agent/package.json",
		);
	});

	it("does not download the installer when the local and cloud versions match", async () => {
		const hosted = await serve({
			"/package.json": { body: JSON.stringify({ version: "0.81.1" }), contentType: "application/json", status: 200 },
			"/install.cjs": {
				body: "throw new Error('installer should not run')",
				contentType: "application/javascript",
				status: 200,
			},
		});
		try {
			await runCodeifyUpdate({
				currentVersion: "0.81.1",
				installerUrl: `${hosted.baseUrl}/install.cjs`,
				versionUrl: `${hosted.baseUrl}/package.json`,
			});
		} finally {
			await hosted.close();
		}
		expect(hosted.requests).toEqual(["/package.json"]);
	});

	it("downloads and executes the installer", async () => {
		const directory = await mkdtemp(join(tmpdir(), "codeify-update-test-"));
		directories.push(directory);
		const marker = join(directory, "updated.txt");
		const hosted = await serve({
			"/package.json": { body: JSON.stringify({ version: "0.81.2" }), contentType: "application/json", status: 200 },
			"/install.cjs": {
				body: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "updated", "utf8");`,
				contentType: "application/javascript",
				status: 200,
			},
		});
		try {
			await runCodeifyUpdate({
				currentVersion: "0.81.1",
				installerUrl: `${hosted.baseUrl}/install.cjs`,
				versionUrl: `${hosted.baseUrl}/package.json`,
			});
		} finally {
			await hosted.close();
		}
		expect(await readFile(marker, "utf8")).toBe("updated");
		expect(hosted.requests).toEqual(["/package.json", "/install.cjs"]);
	});

	it("rejects failed installer downloads", async () => {
		const hosted = await serve({
			"/package.json": { body: JSON.stringify({ version: "0.81.2" }), contentType: "application/json", status: 200 },
			"/install.cjs": { body: "unavailable", contentType: "text/plain", status: 503 },
		});
		try {
			await expect(
				runCodeifyUpdate({
					currentVersion: "0.81.1",
					installerUrl: `${hosted.baseUrl}/install.cjs`,
					versionUrl: `${hosted.baseUrl}/package.json`,
				}),
			).rejects.toThrow("Installer download failed: HTTP 503");
		} finally {
			await hosted.close();
		}
	});

	it("rejects failed cloud version checks without requesting the installer", async () => {
		const hosted = await serve({
			"/package.json": { body: "unavailable", contentType: "text/plain", status: 503 },
			"/install.cjs": {
				body: "throw new Error('installer should not run')",
				contentType: "application/javascript",
				status: 200,
			},
		});
		try {
			await expect(
				runCodeifyUpdate({
					currentVersion: "0.81.1",
					installerUrl: `${hosted.baseUrl}/install.cjs`,
					versionUrl: `${hosted.baseUrl}/package.json`,
				}),
			).rejects.toThrow("Version check failed: HTTP 503");
		} finally {
			await hosted.close();
		}
		expect(hosted.requests).toEqual(["/package.json"]);
	});
});
