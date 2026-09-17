export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	type CodeifyModelToolDetails,
	type CodeifyModelToolInput,
	type CodeifyModelToolOptions,
	type CodeifyModelToolRuntime,
	createCodeifyModelToolDefinition,
} from "./codeify-model.ts";
export {
	type ContextUsageOperations,
	type ContextUsageSnapshot,
	type ContextUsageToolDetails,
	type ContextUsageToolInput,
	createContextUsageToolDefinition,
} from "./context-usage.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	createGlobTool,
	createGlobToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
	type GlobToolInput,
	type GlobToolOptions,
} from "./find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export type {
	ToolDefinition,
	ToolExecutionContext,
	ToolInfo,
	ToolRenderContext,
	ToolRenderResultOptions,
} from "./types.ts";
export {
	createWebSearchTool,
	createWebSearchToolDefinition,
	type WebSearchToolDetails,
	type WebSearchToolInput,
	type WebSearchToolOptions,
} from "./web-search.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "codeify-agent-core";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import {
	createFindTool,
	createFindToolDefinition,
	createGlobTool,
	createGlobToolDefinition,
	type FindToolOptions,
} from "./find.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import type { ToolDefinition } from "./types.ts";
import { createWebSearchTool, createWebSearchToolDefinition, type WebSearchToolOptions } from "./web-search.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName =
	| "read"
	| "bash"
	| "edit"
	| "write"
	| "grep"
	| "find"
	| "glob"
	| "ls"
	| "web_search"
	| "websearch"
	| "view_file"
	| "replace_file_content"
	| "write_to_file"
	| "run_command"
	| "grep_search"
	| "find_by_name"
	| "list_dir"
	| "search_web";
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"glob",
	"ls",
	"web_search",
	"websearch",
	"view_file",
	"replace_file_content",
	"write_to_file",
	"run_command",
	"grep_search",
	"find_by_name",
	"list_dir",
	"search_web",
]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	glob?: FindToolOptions;
	ls?: LsToolOptions;
	web_search?: WebSearchToolOptions;
	websearch?: WebSearchToolOptions;
	view_file?: ReadToolOptions;
	replace_file_content?: EditToolOptions;
	write_to_file?: WriteToolOptions;
	run_command?: BashToolOptions;
	grep_search?: GrepToolOptions;
	find_by_name?: FindToolOptions;
	list_dir?: LsToolOptions;
	search_web?: WebSearchToolOptions;
}

export function createToolDefinition(toolName: ToolName | (string & {}), cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName.toLowerCase()) {
		case "read":
		case "view_file":
		case "view":
			return createReadToolDefinition(cwd, options?.read ?? options?.view_file);
		case "bash":
		case "run_command":
		case "execute_command":
			return createBashToolDefinition(cwd, options?.bash ?? options?.run_command);
		case "edit":
		case "replace_file_content":
			return createEditToolDefinition(cwd, options?.edit ?? options?.replace_file_content);
		case "write":
		case "write_to_file":
			return createWriteToolDefinition(cwd, options?.write ?? options?.write_to_file);
		case "grep":
		case "grep_search":
			return createGrepToolDefinition(cwd, options?.grep ?? options?.grep_search);
		case "find":
		case "find_by_name":
			return createFindToolDefinition(cwd, options?.find ?? options?.glob ?? options?.find_by_name);
		case "glob":
			return createGlobToolDefinition(cwd, options?.glob ?? options?.find ?? options?.find_by_name);
		case "ls":
		case "list_dir":
			return createLsToolDefinition(cwd, options?.ls ?? options?.list_dir);
		case "web_search":
		case "websearch":
		case "search_web":
			return createWebSearchToolDefinition(cwd, options?.web_search ?? options?.websearch ?? options?.search_web);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName | (string & {}), cwd: string, options?: ToolsOptions): Tool {
	switch (toolName.toLowerCase()) {
		case "read":
		case "view_file":
		case "view":
			return createReadTool(cwd, options?.read ?? options?.view_file);
		case "bash":
		case "run_command":
		case "execute_command":
			return createBashTool(cwd, options?.bash ?? options?.run_command);
		case "edit":
		case "replace_file_content":
			return createEditTool(cwd, options?.edit ?? options?.replace_file_content);
		case "write":
		case "write_to_file":
			return createWriteTool(cwd, options?.write ?? options?.write_to_file);
		case "grep":
		case "grep_search":
			return createGrepTool(cwd, options?.grep ?? options?.grep_search);
		case "find":
		case "find_by_name":
			return createFindTool(cwd, options?.find ?? options?.glob ?? options?.find_by_name);
		case "glob":
			return createGlobTool(cwd, options?.glob ?? options?.find ?? options?.find_by_name);
		case "ls":
		case "list_dir":
			return createLsTool(cwd, options?.ls ?? options?.list_dir);
		case "web_search":
		case "websearch":
		case "search_web":
			return createWebSearchTool(cwd, options?.web_search ?? options?.websearch ?? options?.search_web);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find ?? options?.glob),
		createLsToolDefinition(cwd, options?.ls),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find ?? options?.glob),
		glob: createGlobToolDefinition(cwd, options?.glob ?? options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
		web_search: createWebSearchToolDefinition(cwd, options?.web_search ?? options?.websearch),
		websearch: createWebSearchToolDefinition(cwd, options?.websearch ?? options?.web_search),
		view_file: createReadToolDefinition(cwd, options?.view_file ?? options?.read),
		replace_file_content: createEditToolDefinition(cwd, options?.replace_file_content ?? options?.edit),
		write_to_file: createWriteToolDefinition(cwd, options?.write_to_file ?? options?.write),
		run_command: createBashToolDefinition(cwd, options?.run_command ?? options?.bash),
		grep_search: createGrepToolDefinition(cwd, options?.grep_search ?? options?.grep),
		find_by_name: createFindToolDefinition(cwd, options?.find_by_name ?? options?.find ?? options?.glob),
		list_dir: createLsToolDefinition(cwd, options?.list_dir ?? options?.ls),
		search_web: createWebSearchToolDefinition(cwd, options?.search_web ?? options?.web_search ?? options?.websearch),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createGrepTool(cwd, options?.grep),
		createFindTool(cwd, options?.find ?? options?.glob),
		createLsTool(cwd, options?.ls),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find ?? options?.glob),
		glob: createGlobTool(cwd, options?.glob ?? options?.find),
		ls: createLsTool(cwd, options?.ls),
		web_search: createWebSearchTool(cwd, options?.web_search ?? options?.websearch),
		websearch: createWebSearchTool(cwd, options?.websearch ?? options?.web_search),
		view_file: createReadTool(cwd, options?.view_file ?? options?.read),
		replace_file_content: createEditTool(cwd, options?.replace_file_content ?? options?.edit),
		write_to_file: createWriteTool(cwd, options?.write_to_file ?? options?.write),
		run_command: createBashTool(cwd, options?.run_command ?? options?.bash),
		grep_search: createGrepTool(cwd, options?.grep_search ?? options?.grep),
		find_by_name: createFindTool(cwd, options?.find_by_name ?? options?.find ?? options?.glob),
		list_dir: createLsTool(cwd, options?.list_dir ?? options?.ls),
		search_web: createWebSearchTool(cwd, options?.search_web ?? options?.web_search ?? options?.websearch),
	};
}
