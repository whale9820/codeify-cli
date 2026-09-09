import chalk from "chalk";
import { fuzzyFilter } from "codeify-tui";
import { formatNoModelsAvailableMessage } from "../core/auth-guidance.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";

export async function listModels(modelRuntime: ModelRuntime, searchPattern?: string): Promise<void> {
	const loadError = modelRuntime.getError();
	if (loadError) {
		console.error(chalk.yellow(`Warning: model catalog error:\n${loadError}`));
	}

	const models = [...(await modelRuntime.getAvailable())];
	if (models.length === 0) {
		console.log(formatNoModelsAvailableMessage());
		return;
	}

	const filteredModels = searchPattern ? fuzzyFilter(models, searchPattern, (model) => model.id) : models;
	if (filteredModels.length === 0) {
		console.log(`No models matching "${searchPattern}"`);
		return;
	}

	filteredModels.sort((a, b) => a.id.localeCompare(b.id));
	for (const model of filteredModels) {
		console.log(model.id);
	}
}
