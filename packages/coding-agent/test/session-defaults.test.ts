import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { codeifyProvider } from "../src/core/codeify-provider.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

afterEach(() => vi.restoreAllMocks());

describe("session defaults", () => {
	it.each(["fresh", "saved", "override", "resume"] as const)(
		"honors model and effort precedence: %s",
		async (mode) => {
			const directory = mkdtempSync(join(tmpdir(), "codeify-defaults-test-"));
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
			try {
				const modelRuntime = await ModelRuntime.create({
					credentials: AuthStorage.inMemory({ codeify: { type: "api_key", key: "test-key" } }),
					modelsPath: null,
					includeBuiltinProviders: false,
				});
				const provider = codeifyProvider();
				const astra = provider.models![0];
				modelRuntime.registerProvider("codeify", {
					...provider,
					refreshModels: undefined,
					models: [{ ...astra, id: "gpt-5.6-sol" }, astra],
				});
				const settingsManager = SettingsManager.inMemory(
					mode === "saved"
						? {
								defaultProvider: "codeify",
								defaultModel: "gpt-5.6-sol",
								defaultThinkingLevel: "medium",
							}
						: {},
				);
				const services = await createAgentSessionServices({
					cwd: directory,
					agentDir: directory,
					modelRuntime,
					settingsManager,
					includeBuiltinProviders: false,
					resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
				});
				const sessionManager = SessionManager.inMemory(directory);
				if (mode === "resume") {
					sessionManager.appendModelChange("codeify", "gpt-5.6-sol");
					sessionManager.appendThinkingLevelChange("low");
					sessionManager.appendMessage({ role: "user", content: "previous message", timestamp: Date.now() });
				}
				const { session } = await createAgentSessionFromServices({
					services,
					sessionManager,
					...(mode === "override"
						? { model: modelRuntime.getModel("codeify", "gpt-5.6-sol"), thinkingLevel: "off" as const }
						: {}),
				});
				try {
					expect(session.model?.id).toBe(mode === "fresh" ? "gpt-6-astra" : "gpt-5.6-sol");
					expect(session.thinkingLevel).toBe(
						{ fresh: "xhigh", saved: "medium", override: "off", resume: "low" }[mode],
					);
					expect(fetchSpy).not.toHaveBeenCalled();
				} finally {
					session.dispose();
				}
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
});
