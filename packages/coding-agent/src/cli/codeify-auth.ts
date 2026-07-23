import { getAuthPath } from "../config.ts";
import { AuthStorage, readStoredCredential } from "../core/auth-storage.ts";
import { CODEIFY_PROVIDER_ID, loginWithCodeifyOAuth } from "../core/codeify-provider.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { showStartupInput, showStartupSelector } from "./startup-ui.ts";

export function hasCodeifyCredential(): boolean {
	if (process.env.CODEIFY_API_KEY?.trim()) return true;
	const credential = readStoredCredential(CODEIFY_PROVIDER_ID, getAuthPath());
	return credential?.type === "api_key"
		? Boolean(credential.key?.trim())
		: credential?.type === "oauth" && Boolean(credential.access?.trim());
}

export async function ensureCodeifyAuth(settingsManager: SettingsManager): Promise<boolean> {
	if (hasCodeifyCredential()) return true;
	const choice = await showStartupSelector(settingsManager, "Sign in to Codeify", [
		{ label: "Continue with Codeify OAuth", value: "oauth" as const },
		{ label: "Enter Codeify API key", value: "api_key" as const },
	]);
	if (!choice) return false;
	const storage = AuthStorage.create(getAuthPath());
	if (choice === "api_key") {
		const key = (
			await showStartupInput(settingsManager, "Enter Codeify API key", "codeify_...", { secret: true })
		)?.trim();
		if (!key) return false;
		await storage.modify(CODEIFY_PROVIDER_ID, async () => ({ type: "api_key", key }));
		return true;
	}
	const credential = await loginWithCodeifyOAuth({
		signal: undefined,
		onAuth: ({ url }) => console.log(`Opening Codeify OAuth in your browser: ${url}`),
		onDeviceCode: () => {},
		onPrompt: async () => {
			throw new Error("Codeify OAuth did not complete in the browser");
		},
		onManualCodeInput: async () => {
			throw new Error("Codeify OAuth did not complete in the browser");
		},
		onSelect: async () => undefined,
	});
	await storage.modify(CODEIFY_PROVIDER_ID, async () => ({ type: "oauth", ...credential }));
	return true;
}
