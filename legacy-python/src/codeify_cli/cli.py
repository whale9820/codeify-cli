from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Sequence

from . import __title__, __version__
from .agent import CodingAgent
from .api import ApiError, ResponsesClient
from .config import Config, doctor, load_config, save_config, unset_config
from .sessions import Session, SessionStore
from .slash_commands import handle_slash_command
from .terminal import Terminal


COMMANDS = {"run", "exec", "resume", "sessions", "init", "login", "logout", "config", "doctor", "models", "api", "completion", "version"}
GLOBAL_VALUE_OPTIONS = {"--api-key", "--endpoint", "--model", "--reasoning", "--approval", "--workspace", "--timeout", "--max-tool-loops", "--max-output-tokens", "--temperature"}
GLOBAL_FLAG_OPTIONS = {"--json", "--no-color", "--quiet", "--no-store", "--version", "-h", "--help"}


def normalize_argv(argv: list[str]) -> list[str]:
    if not argv:
        return argv
    command_index = next((index for index, token in enumerate(argv) if token in COMMANDS), None)
    global_tokens: list[str] = []
    remainder: list[str] = []
    index = 0
    while index < len(argv):
        token = argv[index]
        init_local = command_index is not None and argv[command_index] in {"init", "login"} and index > command_index and token in {"--endpoint", "--model"}
        if token in GLOBAL_FLAG_OPTIONS and token not in {"--version", "-h", "--help"}:
            global_tokens.append(token)
        elif token in GLOBAL_VALUE_OPTIONS and not init_local:
            global_tokens.append(token)
            if index + 1 < len(argv):
                global_tokens.append(argv[index + 1])
                index += 1
        elif any(token.startswith(option + "=") for option in GLOBAL_VALUE_OPTIONS) and not init_local:
            global_tokens.append(token)
        else:
            remainder.append(token)
        index += 1
    argv = global_tokens + remainder
    index = 0
    while index < len(argv):
        token = argv[index]
        if token == "--":
            return argv[: index + 1] + ["run", *argv[index + 1 :]]
        if token in GLOBAL_VALUE_OPTIONS:
            index += 2
            continue
        if any(token.startswith(option + "=") for option in GLOBAL_VALUE_OPTIONS):
            index += 1
            continue
        if token in GLOBAL_FLAG_OPTIONS:
            index += 1
            continue
        if token in COMMANDS:
            return argv
        if not token.startswith("-"):
            return argv[:index] + ["run", *argv[index:]]
        return argv
    return argv


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="codeify",
        description="Codeify's agentic coding CLI, powered by the Responses API.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Run `codeify` for an interactive session or `codeify \"fix the tests\"` for a one-shot task.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    parser.add_argument("--json", action="store_true", help="Emit stable JSON to stdout")
    parser.add_argument("--no-color", action="store_true", help="Disable ANSI color")
    parser.add_argument("--quiet", action="store_true", help="Suppress progress and banners")
    parser.add_argument("--api-key", help="One-off API key override; env or config is safer")
    parser.add_argument("--endpoint", help="Responses-compatible API base URL")
    parser.add_argument("--model", help="Model ID")
    parser.add_argument("--reasoning", choices=["none", "low", "medium", "high", "xhigh", "max"], help="Reasoning effort")
    parser.add_argument("--approval", choices=["ask", "auto-edit", "full-auto", "plan"], help="Tool approval policy")
    parser.add_argument("--workspace", help="Workspace root")
    parser.add_argument("--timeout", type=float, help="API and default command timeout in seconds")
    parser.add_argument("--max-tool-loops", type=int, help="Maximum tool continuation rounds")
    parser.add_argument("--max-output-tokens", type=int, help="Maximum model output tokens")
    parser.add_argument("--temperature", type=float, help="Optional model temperature")
    parser.add_argument("--no-store", action="store_true", help="Request non-persisted API responses")

    subparsers = parser.add_subparsers(dest="command")
    run_parser = subparsers.add_parser("run", help="Run one agent task")
    run_parser.add_argument("prompt", nargs="*", help="Task for the coding agent")
    run_parser.add_argument("--file", type=Path, help="Read the task from a UTF-8 file")
    run_parser.add_argument("--stdin", action="store_true", help="Read the task from stdin")
    run_parser.add_argument("--continue", dest="continue_interactive", action="store_true", help="Stay in an interactive session after completion")

    exec_parser = subparsers.add_parser("exec", help="Run one non-interactive agent task")
    exec_parser.add_argument("prompt", nargs="*", help="Task for the coding agent")
    exec_parser.add_argument("--file", type=Path, help="Read the task from a UTF-8 file")
    exec_parser.add_argument("--stdin", action="store_true", help="Read the task from stdin")

    resume_parser = subparsers.add_parser("resume", help="Resume a saved session")
    resume_parser.add_argument("session_id", nargs="?", help="Session ID or prefix; defaults to latest in this workspace")
    resume_parser.add_argument("prompt", nargs="*", help="Optional next task")

    sessions_parser = subparsers.add_parser("sessions", help="List, inspect, or delete saved sessions")
    sessions_subparsers = sessions_parser.add_subparsers(dest="sessions_command")
    sessions_list = sessions_subparsers.add_parser("list", help="List saved sessions")
    sessions_list.add_argument("--limit", type=int, default=20)
    sessions_list.add_argument("--all-workspaces", action="store_true")
    sessions_show = sessions_subparsers.add_parser("show", help="Show one session")
    sessions_show.add_argument("session_id")
    sessions_delete = sessions_subparsers.add_parser("delete", help="Delete one saved session")
    sessions_delete.add_argument("session_id")

    init_parser = subparsers.add_parser("init", help="Configure Codeify authentication and defaults")
    init_parser.add_argument("--key", help="API key to save")
    init_parser.add_argument("--endpoint", dest="init_endpoint", help="API base URL to save")
    init_parser.add_argument("--model", dest="init_model", help="Default model to save")
    init_parser.add_argument("--non-interactive", action="store_true")

    login_parser = subparsers.add_parser("login", help="Save a Codeify API key")
    login_parser.add_argument("--key", help="API key to save")
    subparsers.add_parser("logout", help="Remove the saved API key")

    config_parser = subparsers.add_parser("config", help="Read or update persistent configuration")
    config_subparsers = config_parser.add_subparsers(dest="config_command")
    config_subparsers.add_parser("list", help="List effective redacted configuration")
    config_get = config_subparsers.add_parser("get", help="Read one effective value")
    config_get.add_argument("key")
    config_set = config_subparsers.add_parser("set", help="Save one configuration value")
    config_set.add_argument("key")
    config_set.add_argument("value")
    config_unset = config_subparsers.add_parser("unset", help="Remove one saved configuration value")
    config_unset.add_argument("key")

    doctor_parser = subparsers.add_parser("doctor", help="Check auth, config, workspace, and API connectivity")
    doctor_parser.add_argument("--check-network", action="store_true")

    models_parser = subparsers.add_parser("models", help="List models exposed by the configured provider")
    models_parser.add_argument("--limit", type=int, default=100)

    api_parser = subparsers.add_parser("api", help="Make a raw authenticated API request")
    api_parser.add_argument("method", choices=["GET", "POST", "PUT", "PATCH", "DELETE", "get", "post", "put", "patch", "delete"])
    api_parser.add_argument("path", help="API path such as /models or /responses")
    api_parser.add_argument("--data", help="JSON request body or @path/to/file.json")

    completion_parser = subparsers.add_parser("completion", help="Print a shell completion script")
    completion_parser.add_argument("shell", choices=["bash", "zsh"])
    subparsers.add_parser("version", help="Print version information")
    return parser


def config_overrides(args: argparse.Namespace) -> dict[str, Any]:
    values = {
        "api_key": getattr(args, "api_key", None),
        "endpoint": getattr(args, "endpoint", None),
        "model": getattr(args, "model", None),
        "reasoning": getattr(args, "reasoning", None),
        "approval": getattr(args, "approval", None),
        "workspace": getattr(args, "workspace", None),
        "timeout": getattr(args, "timeout", None),
        "max_tool_loops": getattr(args, "max_tool_loops", None),
        "max_output_tokens": getattr(args, "max_output_tokens", None),
        "temperature": getattr(args, "temperature", None),
    }
    if getattr(args, "no_store", False):
        values["store"] = False
    return {key: value for key, value in values.items() if value is not None}


def get_prompt(args: argparse.Namespace) -> str:
    sources = sum(bool(value) for value in (getattr(args, "prompt", None), getattr(args, "file", None), getattr(args, "stdin", False)))
    if sources > 1:
        raise ValueError("Provide the prompt as arguments, --file, or --stdin, not more than one")
    if getattr(args, "file", None):
        return args.file.read_text(encoding="utf-8").strip()
    if getattr(args, "stdin", False):
        return sys.stdin.read().strip()
    return " ".join(getattr(args, "prompt", [])).strip()


def build_terminal(args: argparse.Namespace, config: Config) -> Terminal:
    return Terminal(color=config.color and not args.no_color, json_mode=args.json, quiet=args.quiet)


def run_agent(config: Config, terminal: Terminal, prompt: str, session: Session | None = None, interactive: bool = False) -> Session:
    if not prompt:
        raise ValueError("A task is required")
    agent = CodingAgent(config, terminal, interactive=interactive)
    result = agent.run(prompt, session=session)
    if terminal.json_mode:
        terminal.emit_json(result.as_dict())
    elif terminal.quiet and result.text:
        print(result.text, flush=True)
    elif interactive:
        terminal.footer(str(config.resolved_workspace), config.model, config.reasoning, result.session.usage.get("total_tokens", 0))
    return result.session


def interactive_loop(config: Config, terminal: Terminal, session: Session | None = None) -> None:
    terminal.banner(config.model, str(config.resolved_workspace), config.reasoning)
    current = session
    active_config = config
    while True:
        prompt = terminal.user_prompt()
        if prompt is None or prompt.lower() in {"/exit", "/quit", "exit", "quit"}:
            terminal.print()
            return
        if not prompt:
            continue
        if prompt.startswith("/"):
            current, active_config, should_exit = handle_slash_command(prompt, current, active_config, terminal)
            if should_exit:
                return
            continue
        if prompt.startswith("!"):
            agent = CodingAgent(active_config, terminal, interactive=True)
            result = agent.tools.execute("run_command", {"command": prompt[1:].strip()})
            terminal.tool_end(result.ok, result.output, 0.0)
            if result.output:
                terminal.print(result.output)
            continue
        try:
            current = run_agent(active_config, terminal, prompt, current, interactive=True)
        except (ApiError, RuntimeError, ValueError, KeyboardInterrupt) as exc:
            terminal.error("Interrupted" if isinstance(exc, KeyboardInterrupt) else str(exc))


def handle_init(args: argparse.Namespace, config: Config, terminal: Terminal, login_only: bool = False) -> int:
    key = getattr(args, "key", None)
    non_interactive = getattr(args, "non_interactive", False)
    if not key and not non_interactive and sys.stdin.isatty():
        import getpass
        key = getpass.getpass("Codeify API key: ").strip()
    if not key:
        raise ValueError("An API key is required; pass --key or run interactively")
    values: dict[str, Any] = {"api_key": key}
    if not login_only:
        values["endpoint"] = getattr(args, "init_endpoint", None) or config.endpoint
        values["model"] = getattr(args, "init_model", None) or config.model
    path = save_config(values)
    output = {"ok": True, "config_path": str(path), "endpoint": values.get("endpoint", config.endpoint), "model": values.get("model", config.model), "api_key": "configured"}
    terminal.emit_json(output) if terminal.json_mode else terminal.print(f"Configured Codeify at {path}")
    return 0


def remove_config_key(key: str) -> Path:
    return unset_config(key)


def parse_config_value(key: str, value: str) -> Any:
    if key in {"store", "color", "telemetry"}:
        lowered = value.lower()
        if lowered not in {"true", "false"}:
            raise ValueError(f"{key} must be true or false")
        return lowered == "true"
    if key in {"max_tool_loops", "max_output_tokens"}:
        return int(value)
    if key in {"timeout", "temperature"}:
        return float(value)
    if key == "approval" and value not in {"ask", "auto-edit", "full-auto", "plan"}:
        raise ValueError("approval must be ask, auto-edit, full-auto, or plan")
    if key == "reasoning" and value not in {"none", "low", "medium", "high", "xhigh", "max"}:
        raise ValueError("invalid reasoning effort")
    if key not in Config.__dataclass_fields__ or key == "source":
        raise ValueError(f"Unknown configuration key: {key}")
    return value


def shell_completion(shell: str) -> str:
    commands = " ".join(sorted(COMMANDS))
    if shell == "zsh":
        return f"#compdef codeify\n_arguments '1:command:({commands})' '*::arg:->args'\n"
    return f"_codeify() {{ COMPREPLY=($(compgen -W '{commands}' -- \"${{COMP_WORDS[1]}}\")); }}\ncomplete -F _codeify codeify\n"


def main(argv: Sequence[str] | None = None) -> int:
    raw_argv = list(argv if argv is not None else sys.argv[1:])
    parser = build_parser()
    args = parser.parse_args(normalize_argv(raw_argv))
    try:
        config = load_config(config_overrides(args))
        terminal = build_terminal(args, config)
        command = args.command
        if command is None:
            if args.json:
                raise ValueError("A command is required with --json; use `codeify --json run ...`")
            interactive_loop(config, terminal)
            return 0
        if command in {"run", "exec"}:
            prompt = get_prompt(args)
            if not prompt and sys.stdin.isatty() and command == "run":
                interactive_loop(config, terminal)
                return 0
            can_prompt = command == "run" and not args.json and sys.stdin.isatty() and sys.stdout.isatty()
            session = run_agent(config, terminal, prompt, interactive=can_prompt)
            if command == "run" and args.continue_interactive:
                interactive_loop(config, terminal, session)
            return 0
        if command == "resume":
            store = SessionStore()
            session = store.load(args.session_id) if args.session_id else store.latest(config.resolved_workspace)
            prompt = " ".join(args.prompt).strip()
            if prompt:
                can_prompt = not args.json and sys.stdin.isatty() and sys.stdout.isatty()
                session = run_agent(config, terminal, prompt, session=session, interactive=can_prompt)
                return 0
            interactive_loop(config, terminal, session)
            return 0
        if command == "sessions":
            store = SessionStore()
            subcommand = args.sessions_command or "list"
            if subcommand == "list":
                workspace = None if getattr(args, "all_workspaces", False) else config.resolved_workspace
                sessions = store.list(max(1, min(getattr(args, "limit", 20), 500)), workspace)
                values = [{"id": item.id, "updated_at": item.updated_at, "title": item.title, "workspace": item.workspace, "model": item.model, "messages": len(item.messages), "usage": item.usage} for item in sessions]
                if terminal.json_mode:
                    terminal.emit_json({"ok": True, "sessions": values})
                elif not values:
                    terminal.print("No saved sessions")
                else:
                    for item in values:
                        terminal.print(f"{item['id']}  {item['updated_at']}  {item['title']}")
            elif subcommand == "show":
                item = store.load(args.session_id)
                terminal.emit_json({"ok": True, "session": item.as_dict()})
            elif subcommand == "delete":
                deleted = store.delete(args.session_id)
                terminal.emit_json({"ok": True, "deleted": str(deleted)}) if terminal.json_mode else terminal.print(f"Deleted session {args.session_id}")
            return 0
        if command in {"init", "login"}:
            return handle_init(args, config, terminal, login_only=command == "login")
        if command == "logout":
            path = remove_config_key("api_key")
            terminal.emit_json({"ok": True, "config_path": str(path)}) if terminal.json_mode else terminal.print("Removed saved API key")
            return 0
        if command == "config":
            subcommand = args.config_command or "list"
            if subcommand == "list":
                terminal.emit_json({"ok": True, "config": config.as_dict()}) if terminal.json_mode else terminal.emit_json(config.as_dict())
            elif subcommand == "get":
                values = config.as_dict()
                if args.key not in values:
                    raise ValueError(f"Unknown configuration key: {args.key}")
                terminal.emit_json({"ok": True, "key": args.key, "value": values[args.key]}) if terminal.json_mode else terminal.print(str(values[args.key]))
            elif subcommand == "set":
                value = parse_config_value(args.key, args.value)
                path = save_config({args.key: value})
                terminal.emit_json({"ok": True, "key": args.key, "value": value, "config_path": str(path)}) if terminal.json_mode else terminal.print(f"Set {args.key}")
            elif subcommand == "unset":
                path = remove_config_key(args.key)
                terminal.emit_json({"ok": True, "key": args.key, "config_path": str(path)}) if terminal.json_mode else terminal.print(f"Unset {args.key}")
            return 0
        if command == "doctor":
            result = doctor(config)
            if args.check_network:
                try:
                    result["network"] = ResponsesClient(config.api_key, config.endpoint, config.timeout).check()
                except ApiError as exc:
                    result["ok"] = False
                    result["network"] = {"ok": False, "error": str(exc), "status": exc.status}
                    result["next"] = "Check the configured API key and endpoint"
            terminal.emit_json(result) if terminal.json_mode else terminal.emit_json(result)
            return 0 if result["ok"] else 1
        if command == "models":
            models = ResponsesClient(config.api_key, config.endpoint, config.timeout).list_models()[: max(1, min(args.limit, 1000))]
            if terminal.json_mode:
                terminal.emit_json({"ok": True, "models": models})
            else:
                for item in models:
                    terminal.print(str(item.get("id", item)))
            return 0
        if command == "api":
            if not config.api_key:
                raise ValueError("No API key configured")
            body = None
            if args.data:
                raw = Path(args.data[1:]).read_text(encoding="utf-8") if args.data.startswith("@") else args.data
                body = json.loads(raw)
            response = ResponsesClient(config.api_key, config.endpoint, config.timeout).request_json(args.method.upper(), args.path, body)
            terminal.emit_json({"ok": True, "data": response})
            return 0
        if command == "completion":
            terminal.print(shell_completion(args.shell))
            return 0
        if command == "version":
            terminal.emit_json({"name": __title__, "version": __version__}) if terminal.json_mode else terminal.print(f"codeify {__version__}")
            return 0
        parser.print_help()
        return 0
    except KeyboardInterrupt:
        if "terminal" in locals():
            terminal.error("Interrupted")
        return 130
    except (ApiError, OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        if "terminal" in locals():
            terminal.error(str(exc))
        else:
            print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
