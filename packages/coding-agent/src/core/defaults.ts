import type { ThinkingLevel } from "codeify-agent-core";

export const CODEIFY_DEFAULT_MODEL = process.env.CODEIFY_MODEL ?? "gpt-6-astra";
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "xhigh";
