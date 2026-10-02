import { readFile } from "node:fs/promises";
import type { AgentToolResult } from "codeify-agent-core";
import type { ImageContent, TextContent } from "codeify-ai";
import { Text } from "codeify-tui";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { processImage } from "../../utils/image-process.ts";
import type { BrowserBridge } from "./browser-bridge.ts";
import { resolveToCwd } from "./path-utils.ts";
import { capOutputWithNotice, type SpillResult } from "./spill.ts";
import { defineTool, type ToolDefinition } from "./types.ts";

const ACTIONS = [
	"open",
	"close",
	"goto",
	"back",
	"forward",
	"reload",
	"click",
	"fill",
	"type",
	"press",
	"select",
	"check",
	"uncheck",
	"hover",
	"scroll",
	"upload",
	"wait",
	"eval",
	"text",
	"html",
	"snapshot",
	"screenshot",
	"tabs",
	"new_tab",
	"switch_tab",
	"close_tab",
	"cookies",
	"set_cookies",
	"clear_cookies",
	"network",
	"request",
	"clear_network",
	"export_network",
	"recording",
	"fetch",
] as const;

type BrowserAction = (typeof ACTIONS)[number];

const optionalString = (description: string) => Type.Optional(Type.String({ description }));
const optionalNumber = (description: string) => Type.Optional(Type.Number({ description }));
const optionalBoolean = (description: string) => Type.Optional(Type.Boolean({ description }));

const browserSchema = Type.Object({
	action: Type.Unsafe<BrowserAction>({
		type: "string",
		enum: [...ACTIONS],
		description: "What to do. See the tool description for what each action needs.",
	}),
	url: optionalString("goto/new_tab/fetch: target URL. cookies: restrict to this URL."),
	selector: optionalString(
		"CSS selector or Playwright selector (text=Sign in, role=button[name=Save], etc.). Used by click, fill, type, press, select, check, hover, scroll, upload, wait, text, html, snapshot, screenshot.",
	),
	value: optionalString("fill/type/select: the value. scroll: top, bottom, or a pixel delta."),
	key: optionalString("press: key such as Enter, Tab, Control+A."),
	script: optionalString(
		"eval: JavaScript expression or arrow function evaluated in the page, e.g. () => document.title.",
	),
	path: optionalString("screenshot/export_network: output file path."),
	paths: Type.Optional(Type.Array(Type.String(), { description: "upload: file paths." })),
	tab_id: optionalNumber("Target tab id (from tabs). Defaults to the current tab."),
	timeout_ms: optionalNumber("Per-action timeout in milliseconds. Default 30000."),
	wait_until: optionalString("goto/new_tab: load, domcontentloaded (default), networkidle, or commit."),
	full_page: optionalBoolean("screenshot: capture the full scrollable page."),
	headless: optionalBoolean("open: run without a visible window. Default true."),
	humanize: optionalBoolean("open: simulate human-like cursor movement."),
	os: optionalString("open: fingerprint OS, one of windows, macos, linux."),
	locale: optionalString("open: browser locale, e.g. en-US."),
	geoip: optionalBoolean("open: derive locale and timezone from the egress IP. Implied by proxy."),
	proxy: optionalString("open: proxy URL such as http://user:pass@host:8080."),
	user_data_dir: optionalString("open: persistent profile directory so logins and cookies survive restarts."),
	block_images: optionalBoolean("open: skip image requests for speed."),
	block_webrtc: optionalBoolean("open: disable WebRTC to avoid IP leaks."),
	window: Type.Optional(Type.Array(Type.Number(), { description: "open: [width, height]." })),
	delay_ms: optionalNumber("type: delay between keystrokes. Default 40."),
	button: optionalString("click: left, right, or middle."),
	double: optionalBoolean("click: double click."),
	state: optionalString("wait: visible (default), hidden, attached, or detached for the selector."),
	text: optionalString("wait: wait until this text appears."),
	url_contains: optionalString(
		"wait: wait until the page URL contains this. network/export_network: filter by URL substring.",
	),
	network_idle: optionalBoolean("wait: wait for network idle."),
	ms: optionalNumber("wait: sleep this many milliseconds."),
	url_regex: optionalString("network/export_network: filter by URL regular expression."),
	method: optionalString("network: filter by HTTP method. fetch: HTTP method to use. Default GET."),
	status: optionalString("network: filter by status, e.g. 200 or 4xx."),
	types: Type.Optional(
		Type.Array(Type.String(), {
			description: "network: resource types to keep, e.g. xhr, fetch, document, script, websocket.",
		}),
	),
	api_only: optionalBoolean("network: only API-like traffic (xhr, fetch, websocket, eventsource, JSON responses)."),
	body_contains: optionalString("network: only requests whose request or response body contains this text."),
	exclude: Type.Optional(Type.Array(Type.String(), { description: "network: drop URLs containing any of these." })),
	since_id: optionalNumber("network: only requests with an id greater than this."),
	limit: optionalNumber("network: max rows (default 60, newest kept). request: max websocket frames."),
	id: optionalNumber("request: id of a recorded request, as listed by network."),
	max_body: optionalNumber("request/fetch: max body characters to print. Default 20000."),
	save_to: optionalString("request: write the full response body to this file instead of printing it."),
	as_curl: optionalBoolean("request: also print a curl command that replays it."),
	headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "fetch: request headers." })),
	body: optionalString("fetch: request body. Set content-type in headers."),
	max_redirects: optionalNumber("fetch: max redirects to follow. Default 20; 0 to inspect redirects."),
	enabled: optionalBoolean("recording: turn network recording on or off."),
	cookies: Type.Optional(
		Type.Array(
			Type.Object({
				name: Type.String(),
				value: Type.String(),
				url: Type.Optional(Type.String()),
				domain: Type.Optional(Type.String()),
				path: Type.Optional(Type.String()),
			}),
			{ description: "set_cookies: cookies to add." },
		),
	),
});

export type BrowserToolInput = Static<typeof browserSchema>;

export interface BrowserToolDetails {
	action: string;
	fullOutputPath?: string;
	truncated?: boolean;
}

export interface BrowserToolOptions {
	autoResizeImages?: () => boolean;
}

const MAX_OUTPUT_LINES = 400;
const MAX_OUTPUT_BYTES = 48 * 1024;
const COLLAPSED_LINES = 12;

const INSTALL_FAILURE = /not installed|fetch|CamoufoxNotInstalled|executable doesn't exist/i;

function describeCall(args: Partial<BrowserToolInput> | undefined): string {
	if (!args?.action) return "";
	const target =
		args.url ??
		args.selector ??
		args.script?.slice(0, 80) ??
		args.key ??
		(args.id !== undefined ? `#${args.id}` : undefined) ??
		args.url_contains ??
		args.body_contains;
	return target ? `${args.action} ${target}` : args.action;
}

export function createBrowserToolDefinition(
	cwd: string,
	bridge: BrowserBridge,
	options: BrowserToolOptions = {},
): ToolDefinition<typeof browserSchema, BrowserToolDetails> {
	return defineTool({
		name: "browser",
		label: "Browser",
		description: [
			"Drive a stealth Camoufox (Firefox) browser through Playwright, headless by default, and record every network request it makes.",
			"Use it to walk a website or web app flow (login, search, checkout, API discovery), then inspect the traffic and replay the discovered API calls without the UI.",
			"The browser starts on first use and keeps cookies, tabs and the network log across calls until close.",
			"",
			"Navigation: open (optional launch settings), goto, back, forward, reload, close.",
			"Interaction: click, fill, type, press, select, check, uncheck, hover, scroll, upload, wait.",
			"Page reading: snapshot (accessibility tree, best for finding selectors), text, html, eval (run JS), screenshot.",
			"Tabs and state: tabs, new_tab, switch_tab, close_tab, cookies, set_cookies, clear_cookies.",
			"Traffic: network (list recorded requests, filterable), request (full headers, bodies and websocket frames for one request id, optional curl), export_network (save JSON), clear_network, recording (pause or resume).",
			"Replay: fetch sends an HTTP request using the browser's cookies and TLS/fingerprint, and records it as a replay.",
			"",
			"Workflow for reverse-engineering a flow: goto the start page, clear_network, perform the interaction, then network with api_only and exclude to list the API calls, request with the id to read payloads, and fetch to replay or vary them.",
		].join("\n"),
		promptSnippet:
			"Headless Camoufox browser that records all network traffic: walk web flows, inspect API calls, replay requests with fetch.",
		promptGuidelines: [
			"Use browser to go through web flows and record their API calls: after the flow, use browser network with api_only to list traffic and request with an id to read payloads.",
			"Use browser snapshot to find selectors before clicking or filling; prefer text= or role= selectors over brittle CSS.",
			"Call browser clear_network right before the interaction you want to capture so the log stays small, and filter with api_only, url_contains and exclude.",
			"Use browser fetch to replay a captured API call with modified parameters instead of repeating the UI flow.",
			"Close the browser with browser close when the task is done.",
		],
		parameters: browserSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<BrowserToolDetails>> {
			const { action, ...rest } = params;
			const args: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(rest)) {
				if (value !== undefined) args[key] = value;
			}
			if (typeof args.path === "string") args.path = resolveToCwd(args.path, cwd);
			if (typeof args.save_to === "string") args.save_to = resolveToCwd(args.save_to, cwd);
			if (typeof args.user_data_dir === "string") args.user_data_dir = resolveToCwd(args.user_data_dir, cwd);

			let result: Awaited<ReturnType<BrowserBridge["request"]>>;
			try {
				result = await bridge.request(action, args, signal);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const hint =
					action === "open" || INSTALL_FAILURE.test(message)
						? '\nIf the browser binary is missing run: python3 -m camoufox fetch. If camoufox is missing run: pip3 install -U "camoufox[geoip]".'
						: "";
				throw new Error(`${message}${hint}`);
			}

			const capped: SpillResult = capOutputWithNotice(result.text, {
				maxLines: MAX_OUTPUT_LINES,
				maxBytes: MAX_OUTPUT_BYTES,
				tempFilePrefix: "codeify-browser",
			});
			const content: (TextContent | ImageContent)[] = [{ type: "text", text: capped.text }];

			if (action === "screenshot" && result.file) {
				const supportsImages = !ctx?.model || ctx.model.input.includes("image");
				if (supportsImages) {
					const processed = await processImage(await readFile(result.file), "image/png", {
						autoResizeImages: options.autoResizeImages?.() ?? true,
					});
					if (processed.ok) {
						content.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
					}
				}
			}

			return {
				content,
				details: {
					action,
					fullOutputPath: capped.fullOutputPath,
					truncated: capped.truncation.truncated || undefined,
				},
			};
		},
		renderCall(args, theme) {
			const label = describeCall(args);
			return new Text(`${theme.fg("toolTitle", theme.bold("Browser"))}(${theme.fg("accent", label)})`, 0, 0);
		},
		renderResult(result, options, theme, context) {
			const text = result.content.find((block) => block.type === "text");
			const output = text?.type === "text" ? text.text : "";
			const lines = output.split("\n");
			const color = context.isError ? "error" : "toolOutput";
			const shown = options.expanded ? lines : lines.slice(0, COLLAPSED_LINES);
			let rendered = shown.map((line) => theme.fg(color, line)).join("\n");
			const remaining = lines.length - shown.length;
			if (remaining > 0) {
				rendered += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
			}
			return new Text(rendered, 0, 0);
		},
	});
}
