export interface ModelSearchItem {
	id: string;
	provider?: string;
}

export function getModelSearchText(item: ModelSearchItem): string {
	const { id, provider } = item;
	const providerText = provider ? ` ${provider} ${provider}/${id}` : "";
	return `${id}${providerText}`;
}

/**
 * The /model selector search should rank exact provider-prefixed queries before proxy-provider IDs
 * like openrouter/openai/gpt-5, so keep the bare model ID out of the leading position.
 */
export function getModelSelectorSearchText(item: ModelSearchItem): string {
	return item.id;
}
