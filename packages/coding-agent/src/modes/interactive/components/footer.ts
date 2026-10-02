import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "codeify-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { CODEIFY_PROVIDER_ID } from "../../../core/codeify-provider.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { theme } from "../theme/theme.ts";

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 */
export class FooterComponent implements Component {
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		const state = this.session.state;

		let pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);

		const branch = this.footerData.getGitBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		if (state.model) {
			const providerLabel =
				state.model.provider === CODEIFY_PROVIDER_ID
					? CODEIFY_PROVIDER_ID
					: (this.session.modelRuntime.getProvider(state.model.provider)?.name ?? state.model.provider);
			pwd = `${pwd} • ${providerLabel}`;
		}

		const runningTasks = this.session.getBackgroundTasks().filter((task) => task.status === "running").length;
		const taskSuffix = runningTasks > 0 ? `${runningTasks} ${runningTasks === 1 ? "task" : "tasks"}` : "";

		const sessionName = this.session.sessionManager.getSessionName();

		const indicatorParts: string[] = [];
		if (areExperimentalFeaturesEnabled()) {
			indicatorParts.push(theme.bold(theme.fg("warning", "experimental")));
		}

		const modelSlug = state.model?.id || "no-model";
		let rightSide = modelSlug;
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			rightSide = thinkingLevel === "off" ? `${modelSlug} • thinking off` : `${modelSlug} • ${thinkingLevel}`;
		}

		const margin = "  ";
		const innerWidth = Math.max(1, width - margin.length * 2);
		const minPadding = 2;
		const rightWidth = visibleWidth(rightSide);
		const leftBase = [theme.fg("dim", pwd)];
		if (taskSuffix) leftBase.push(theme.fg("accent", taskSuffix));
		if (sessionName) leftBase.push(theme.fg("dim", sessionName));
		const left =
			leftBase.join(theme.fg("dim", " • ")) +
			(indicatorParts.length > 0 ? theme.fg("dim", " · ") + indicatorParts.join(theme.fg("dim", " · ")) : "");
		const availableForLeft = innerWidth - rightWidth - minPadding;

		if (availableForLeft < 1) {
			return [margin + truncateToWidth(theme.fg("dim", rightSide), innerWidth, theme.fg("dim", "...")) + margin];
		}

		const shownLeft = truncateToWidth(left, availableForLeft, theme.fg("dim", "..."));
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(shownLeft) - rightWidth));
		return [margin + shownLeft + theme.fg("dim", padding + rightSide) + margin];
	}
}
