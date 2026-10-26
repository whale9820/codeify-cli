import { Text } from "codeify-tui";
import { Type } from "typebox";
import type { SshManager } from "../ssh-manager.ts";
import { type BashToolDetails, type BashToolOptions, createBashToolDefinition } from "./bash.ts";
import { formatToolCall, getTextOutput } from "./render-utils.ts";
import type { ToolDefinition } from "./types.ts";

const sshSchema = Type.Object({
	profile: Type.String({ description: "Saved SSH profile name; use ssh_manage to list or add profiles" }),
	command: Type.String({
		description:
			"Command in the persistent remote POSIX shell. cd, exports and shell variables persist between calls.",
	}),
	timeout: Type.Optional(
		Type.Number({
			minimum: 0.001,
			description: "Timeout in seconds. Timeout or cancellation closes this shell and loses its state.",
		}),
	),
});

interface SshRenderState {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
}

export function createSshToolDefinition(
	cwd: string,
	manager: SshManager,
	options?: Pick<BashToolOptions, "background" | "hasPendingBackgroundTasks">,
): ToolDefinition<typeof sshSchema, BashToolDetails | undefined, SshRenderState> {
	const renderer = createBashToolDefinition(cwd, options);
	const background = options?.background;
	return {
		name: "ssh",
		label: "ssh",
		description:
			"Run a command in a persistent SSH shell on a saved profile. One live connection and POSIX shell per profile, reused without a new handshake. Working directory, exports and variables persist. Different profiles have independent shells; calls to one profile run in order. Uses local OpenSSH keys, agent and config. No interactive prompts or stdin: use noninteractive commands and heredocs. Output streams with Bash limits. Disconnect, timeout, cancellation or shell exit loses shell state; a later call opens a fresh shell. Failed commands are never automatically retried.",
		promptSnippet: "Run remote commands in a persistent SSH shell by profile name",
		promptGuidelines: [
			"Use ssh_manage to list or save SSH profiles, then ssh for remote commands instead of wrapping ssh in bash. The same remote shell persists across calls, including cd and environment changes. After a disconnect or interrupted command, verify remote state before retrying a mutation.",
		],
		parameters: sshSchema,
		async execute(id, input, signal, onUpdate, ctx) {
			const tool = createBashToolDefinition(cwd, {
				...options,
				background: background
					? {
							...background,
							adopt: (task) =>
								background.adopt({ ...task, description: `SSH (${input.profile}): ${task.description}` }),
						}
					: undefined,
				operations: {
					exec: (command, localCwd, execOptions) => manager.exec(input.profile, command, localCwd, execOptions),
				},
			});
			try {
				return await tool.execute(id, { command: input.command, timeout: input.timeout }, signal, onUpdate, ctx);
			} catch (error) {
				if (
					error instanceof Error &&
					/Command (?:aborted|timed out)/u.test(error.message) &&
					!manager.isConnected(input.profile)
				) {
					throw new Error(
						`${error.message}\nSSH shell state was lost. Remote changes may have occurred; verify before retrying. The next call opens a new shell.`,
					);
				}
				throw error;
			}
		},
		renderCall(args, theme, context) {
			const component = renderer.renderCall!(args, theme, context) as Text;
			component.setText(
				`${formatToolCall(theme, "SSH", typeof args.command === "string" ? args.command : "...")}${theme.fg("muted", ` (${typeof args.profile === "string" ? args.profile : "..."})`)}`,
			);
			return component;
		},
		renderResult: renderer.renderResult,
	};
}

const sshManageSchema = Type.Object({
	action: Type.Union([
		Type.Literal("list"),
		Type.Literal("add"),
		Type.Literal("edit"),
		Type.Literal("delete"),
		Type.Literal("disconnect"),
	]),
	name: Type.Optional(Type.String({ description: "Profile name, required except for list" })),
	profile: Type.Optional(
		Type.Object(
			{
				host: Type.Optional(Type.String({ description: "Hostname, IP address or existing SSH config Host alias" })),
				user: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				port: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 65535 }), Type.Null()])),
				identityFile: Type.Optional(
					Type.Union([Type.String({ description: "Local private key path, never key contents" }), Type.Null()]),
				),
				configFile: Type.Optional(
					Type.Union([
						Type.String({ description: "Optional local SSH config path, equivalent to ssh -F" }),
						Type.Null(),
					]),
				),
			},
			{ additionalProperties: false, description: "Fields to add or merge on edit; null removes an optional field" },
		),
	),
});

export function createSshManageToolDefinition(manager: SshManager): ToolDefinition<typeof sshManageSchema, undefined> {
	return {
		name: "ssh_manage",
		label: "ssh_manage",
		description:
			"List, add, edit, delete or disconnect named SSH profiles. Profiles persist globally in the Codeify agent directory's ssh.json; live shells last for this agent session. Add requires name and profile.host. Edit merges supplied fields; null removes optional fields. Edit/delete disconnect that profile's shell, losing its working directory and environment. Disconnect keeps the saved profile. Keys stay in local files or ssh-agent; passwords and private key contents are not stored. Unknown hosts must first be trusted using normal SSH outside this tool.",
		promptSnippet: "Manage saved SSH profiles and disconnect persistent remote shells",
		parameters: sshManageSchema,
		async execute(_id, input, signal) {
			if (signal?.aborted) throw new Error("aborted");
			if (input.action === "list") {
				const profiles = await manager.profiles.list();
				const entries = Object.entries(profiles).map(([name, profile]) => ({
					name,
					...profile,
					connected: manager.isConnected(name),
				}));
				return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }], details: undefined };
			}
			if (!input.name) throw new Error("SSH profile name is required.");
			if (input.action === "disconnect") {
				manager.disconnect(input.name);
			} else {
				if (input.action !== "delete" && !input.profile) throw new Error("SSH profile fields are required.");
				await manager.profiles.change(input.action, input.name, input.profile);
				manager.disconnect(input.name);
			}
			return {
				content: [{ type: "text", text: `SSH profile ${input.name}: ${input.action} completed.` }],
				details: undefined,
			};
		},
		renderCall(args, theme) {
			return new Text(
				formatToolCall(theme, "SSHManage", `${args.action ?? "..."}${args.name ? `, ${args.name}` : ""}`),
				0,
				0,
			);
		},
		renderResult(result) {
			return new Text(getTextOutput(result, false), 0, 0);
		},
	};
}
