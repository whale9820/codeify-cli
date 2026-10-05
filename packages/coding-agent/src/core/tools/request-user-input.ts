import { Text, truncateToWidth } from "codeify-tui";
import { type Static, Type } from "typebox";
import type { UserInputRequest } from "../user-input.ts";
import { getTextOutput } from "./render-utils.ts";
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
	return defineTool<typeof schema, { questions: Static<typeof schema>["questions"]; answers: string[] }>({
		name: "request_user_input",
		label: "AskUser",
		description:
			"Ask the user one to three questions and wait for their explicit answers. Optionally provide suggested answers; custom text is always allowed. Omit options for free text. Cancellation provides no answer or approval.",
		promptSnippet: "Ask questions and wait for the user's answers before continuing dependent work.",
		promptGuidelines: [
			"Use request_user_input when you need clarification, a preference, missing information, or explicit approval. Ask concise, self-contained questions with suggested answers when useful. The tool waits for the user; never guess their answer or interpret silence or cancellation as approval.",
		],
		parameters: schema,
		executionMode: "sequential",
		renderCall(args, theme, context) {
			const questions = (args.questions ?? [])
				.map((question) => question?.question?.replace(/\s+/g, " ").trim())
				.filter((question): question is string => Boolean(question));
			const title = theme.fg("toolTitle", theme.bold("AskUser"));
			if (context.expanded) {
				return new Text(`${title}(${theme.fg("toolOutput", questions.join("; ") || "...")})`, 0, 0);
			}
			return {
				invalidate() {},
				render(width) {
					const questionWidth = Math.max(
						1,
						Math.floor((width - 9 - (questions.length - 1) * 2) / Math.max(1, questions.length)),
					);
					const summary =
						questions.map((question) => truncateToWidth(question, questionWidth)).join("; ") || "...";
					return [truncateToWidth(`${title}(${theme.fg("toolOutput", summary)})`, width)];
				},
			};
		},
		renderResult(result, options, theme, context) {
			const output = context.isError ? getTextOutput(result, false) : (result.details?.answers ?? []).join("; ");
			const text = theme.fg(context.isError ? "error" : "toolOutput", output);
			if (options.expanded) return new Text(text, 0, 0);
			return {
				invalidate() {},
				render: (width) => [truncateToWidth(text.replace(/\s+/g, " "), width)],
			};
		},
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
