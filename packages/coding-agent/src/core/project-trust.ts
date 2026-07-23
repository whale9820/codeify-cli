import { CONFIG_DIR_NAME } from "../config.ts";
import type { DefaultProjectTrust } from "./settings-manager.ts";
import {
	getProjectTrustOptions,
	hasTrustRequiringProjectResources,
	type ProjectTrustOption,
	type ProjectTrustStore,
} from "./trust-manager.ts";

export type AppMode = "interactive" | "print" | "json" | "rpc";

export interface ProjectTrustContext {
	cwd: string;
	mode: AppMode;
	hasUI: boolean;
	ui: {
		select(title: string, options: string[]): Promise<string | undefined>;
		confirm(title: string, message: string): Promise<boolean>;
		input(title: string, placeholder?: string): Promise<string | undefined>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
}

export interface ResolveProjectTrustedOptions {
	cwd: string;
	trustStore: ProjectTrustStore;
	trustOverride?: boolean;
	defaultProjectTrust?: DefaultProjectTrust;
	projectTrustContext: ProjectTrustContext;
}

function formatProjectTrustPrompt(cwd: string): string {
	return `Trust project folder?\n${cwd}\n\nThis allows Codeify to load ${CONFIG_DIR_NAME} settings and resources.`;
}

async function selectProjectTrustOption(
	cwd: string,
	ctx: ProjectTrustContext,
): Promise<ProjectTrustOption | undefined> {
	const options = getProjectTrustOptions(cwd, { includeSessionOnly: true });
	const selected = await ctx.ui.select(
		formatProjectTrustPrompt(cwd),
		options.map((option) => option.label),
	);
	return options.find((option) => option.label === selected);
}

function saveProjectTrustPromptResult(trustStore: ProjectTrustStore, result: ProjectTrustOption): void {
	if (result.updates.length > 0) {
		trustStore.setMany(result.updates);
	}
}

export async function resolveProjectTrusted(options: ResolveProjectTrustedOptions): Promise<boolean> {
	if (options.trustOverride !== undefined) {
		return options.trustOverride;
	}
	if (!hasTrustRequiringProjectResources(options.cwd)) {
		return true;
	}

	const decision = options.trustStore.get(options.cwd);
	if (decision !== null) {
		return decision;
	}

	switch (options.defaultProjectTrust ?? "ask") {
		case "always":
			return true;
		case "never":
			return false;
		case "ask":
			break;
	}

	if (!options.projectTrustContext.hasUI) {
		return false;
	}

	const selected = await selectProjectTrustOption(options.cwd, options.projectTrustContext);
	if (selected !== undefined) {
		saveProjectTrustPromptResult(options.trustStore, selected);
		return selected.trusted;
	}
	return false;
}
