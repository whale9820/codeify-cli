import {
	type Api,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	lazyStream,
	type Model,
	type StreamOptions,
} from "codeify-ai";

const PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;

export function streamOverrideFallback(
	model: Model<Api>,
	baseUrl: string,
	options: StreamOptions | undefined,
	stream: (candidate: Model<Api>) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	return lazyStream(model, async () => {
		async function* attempts(): AsyncGenerator<AssistantMessageEvent> {
			const protocols = [model.api, ...PROTOCOLS.filter((api) => api !== model.api)];
			for (const [index, api] of protocols.entries()) {
				const candidate = {
					...model,
					api,
					baseUrl: api === "anthropic-messages" ? baseUrl.replace(/\/v1\/?$/u, "") : baseUrl,
				};
				let started = false;
				for await (const event of stream(candidate)) {
					if (
						event.type === "error" &&
						!started &&
						!options?.signal?.aborted &&
						event.reason !== "aborted" &&
						/^(?:API Error \(404\):|404\b)/u.test(event.error.errorMessage ?? "")
					) {
						if (index < protocols.length - 1) break;
						yield {
							...event,
							error: {
								...event.error,
								errorMessage: `Override backend ${model.provider} at ${baseUrl}: HTTP 404 from all three protocols (/chat/completions, /responses, /messages) for model ${model.id}. Check the backend URL and model availability.`,
							},
						};
						return;
					}
					started = true;
					yield event;
					if (event.type === "error" || event.type === "done") return;
				}
			}
		}
		return attempts();
	});
}
