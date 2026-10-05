import { type Static, Type } from "typebox";
import type { UserInputRequest } from "../user-input.ts";
import { defineTool } from "./types.ts";

const schema = Type.Object({
	questions: Type.Array(
		Type.Object({
			question: Type.String({ minLength: 1, description: "Self-contained question to ask the user" }),
			options: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					minItems: 2,
					maxItems: 5,
					description: "Suggested answers; the user can always type a custom answer",
				}),
			),
		}),
		{ minItems: 1, maxItems: 3 },
	),
});

export function createRequestUserInputToolDefinition(
	request: (request: UserInputRequest, signal: AbortSignal | undefined) => Promise<string[]>,
) {
	return defineTool({
		name: "request_user_input",
		label: "Ask user",
		description:
			"Ask the user one to three questions and wait for their explicit answers. Optionally provide suggested answers; custom text is always allowed. Omit options for free text. Cancellation provides no answer or approval.",
		promptSnippet: "Ask questions and wait for the user's answers before continuing dependent work.",
		promptGuidelines: [
			"Use request_user_input when you need clarification, a preference, missing information, or explicit approval. Ask concise, self-contained questions with suggested answers when useful. The tool waits for the user; never guess their answer or interpret silence or cancellation as approval.",
		],
		parameters: schema,
		executionMode: "sequential",
		async execute(id, params: Static<typeof schema>, signal) {
			if (params.questions.some((question) => !question.question.trim())) {
				throw new Error("Questions must not be blank.");
			}
			const answers = await request({ id, questions: params.questions }, signal);
			return {
				content: [{ type: "text" as const, text: JSON.stringify({ answers }) }],
				details: { questions: params.questions, answers },
			};
		},
	});
}
