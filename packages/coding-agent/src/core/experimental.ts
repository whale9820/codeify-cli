export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.CODEIFY_EXPERIMENTAL === "1";
}
