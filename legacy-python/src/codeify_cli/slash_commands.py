from __future__ import annotations

import getpass
import html
import json
import shlex
import shutil
import subprocess
import tempfile
from dataclasses import replace
from pathlib import Path
from typing import Any

from . import __version__
from .api import ResponsesClient
from .config import Config, load_config, save_config, unset_config
from .sessions import Session, SessionStore, utc_now
from .terminal import Terminal
from .tools import ApprovalPolicy, ToolRegistry


REASONING_LEVELS = ("none", "low", "medium", "high", "xhigh", "max")
APPROVAL_MODES = ("ask", "auto-edit", "full-auto", "plan")
CODEIFY_COMMANDS = (
    ("/help", "show all slash commands"),
    ("/settings", "show active settings"),
    ("/model [ID]", "show or change the model"),
    ("/scoped-models", "list models available for this endpoint"),
    ("/export [PATH]", "export the current session"),
    ("/import PATH", "import a JSON or JSONL session export"),
    ("/share", "share the session as a secret GitHub gist"),
    ("/copy", "copy the last agent message to the clipboard"),
    ("/name [NAME]", "show or set the session name"),
    ("/session", "show session info and usage"),
    ("/changelog", "show release notes"),
    ("/hotkeys", "show interactive keyboard controls"),
    ("/fork", "clone the current session as a new branch"),
    ("/clone", "duplicate the current session"),
    ("/tree", "list saved sessions in this workspace"),
    ("/trust", "show workspace safety policy"),
    ("/login", "configure the Codeify API key"),
    ("/logout", "remove the saved API key"),
    ("/new", "start a new session"),
    ("/compact [INSTRUCTIONS]", "compact the active transcript"),
    ("/resume [ID]", "resume a saved session"),
    ("/reload", "reload persistent configuration"),
    ("/debug", "show diagnostic runtime details"),
    ("/quit", "exit Codeify"),
    ("/reasoning [LEVEL]", "show or set reasoning effort"),
    ("/approval [MODE]", "show or set tool approval"),
    ("/diff", "show the workspace git diff"),
    ("/status", "show current runtime status"),
    ("/clear", "clear the terminal"),
    ("/exit", "exit Codeify"),
)


def handle_slash_command(prompt: str, session: Session | None, config: Config, terminal: Terminal) -> tuple[Session | None, Config, bool]:
    try:
        parts = shlex.split(prompt)
        command = parts[0].lower()
        value = " ".join(parts[1:]).strip()
    except (IndexError, ValueError):
        terminal.error(f"Unknown or incomplete command: {prompt}")
        return session, config, False

    if command in {"/exit", "/quit"}:
        return session, config, True
    if command == "/help":
        terminal.print("Pi-compatible commands:")
        for name, description in CODEIFY_COMMANDS:
            terminal.print(f"  {name:<24} {description}")
        return session, config, False
    if command == "/settings":
        _show_settings(config, session, terminal)
        return session, config, False
    if command == "/debug":
        details = {
            "version": __version__,
            "config_source": config.source,
            "auth_source": config.auth_source,
            "workspace": str(config.resolved_workspace),
            "session_id": session.id if session else None,
            "session_messages": len(session.messages) if session else 0,
        }
        terminal.emit_json(details)
        return session, config, False
    if command == "/model":
        if value:
            config = replace(config, model=value)
            if session is not None:
                session.model = value
                session.updated_at = utc_now()
                SessionStore().save(session)
            terminal.update_status(str(config.resolved_workspace), config.model, config.reasoning)
            terminal.print(f"Model set to {value}")
        else:
            terminal.print(f"Model: {config.model}")
            _list_models(config, terminal)
        return session, config, False
    if command == "/scoped-models":
        _list_models(config, terminal)
        return session, config, False
    if command == "/export":
        _export_session(session, value, config, terminal)
        return session, config, False
    if command == "/import":
        imported = _import_session(value, config, terminal)
        if imported is not None:
            session = imported
        return session, config, False
    if command == "/share":
        _share_session(session, config, terminal)
        return session, config, False
    if command == "/copy":
        _copy_last_message(session, terminal)
        return session, config, False
    if command == "/name":
        if session is None:
            terminal.error("No active session")
        elif value:
            session.title = value
            session.updated_at = utc_now()
            SessionStore().save(session)
            terminal.print(f"Session name set to {value}")
        else:
            terminal.print(session.title)
        return session, config, False
    if command == "/session":
        _show_session(session, terminal)
        return session, config, False
    if command == "/changelog":
        _show_changelog(terminal)
        return session, config, False
    if command == "/hotkeys":
        terminal.print("ctrl+c  interrupt or exit\nctrl+d  exit when the editor is empty\n/       slash commands\n!       run bash through approvals\n\\       continue a prompt on the next line")
        return session, config, False
    if command in {"/fork", "/clone"}:
        session = _clone_session(session, config, terminal, "Forked" if command == "/fork" else "Cloned")
        return session, config, False
    if command == "/tree":
        _show_tree(session, config, terminal)
        return session, config, False
    if command == "/trust":
        terminal.print(f"Workspace: {config.resolved_workspace}\nCodeify restricts tools to this workspace.\nApproval mode: {config.approval}")
        return session, config, False
    if command == "/login":
        config = _login(value, config, terminal)
        return session, config, False
    if command == "/logout":
        unset_config("api_key")
        config = replace(config, api_key=None, auth_source="missing")
        terminal.print("Logged out of Codeify")
        return session, config, False
    if command == "/new":
        terminal.update_status(str(config.resolved_workspace), config.model, config.reasoning, 0)
        terminal.print("Started a new session")
        return None, config, False
    if command == "/compact":
        _compact_session(session, value, config, terminal)
        return session, config, False
    if command == "/resume":
        resumed = _resume_session(value, config, terminal)
        if resumed is not None:
            session = resumed
            config = replace(config, model=session.model, endpoint=session.endpoint)
            terminal.update_status(str(config.resolved_workspace), config.model, config.reasoning, session.usage.get("total_tokens", 0))
        return session, config, False
    if command == "/reload":
        try:
            config = load_config()
            terminal.update_status(str(config.resolved_workspace), config.model, config.reasoning)
            terminal.print("Configuration reloaded")
        except ValueError as exc:
            terminal.error(str(exc))
        return session, config, False
    if command == "/reasoning":
        if not value:
            terminal.print(f"Reasoning: {config.reasoning} (options: {', '.join(REASONING_LEVELS)})")
        else:
            level = "none" if value.lower() == "off" else value.lower()
            if level not in REASONING_LEVELS:
                terminal.error(f"reasoning must be one of: {', '.join(REASONING_LEVELS)}")
            else:
                config = replace(config, reasoning=level)
                terminal.update_status(str(config.resolved_workspace), config.model, config.reasoning)
                terminal.print(f"Reasoning set to {level}")
        return session, config, False
    if command == "/approval":
        if not value:
            terminal.print(f"Approval: {config.approval} (options: {', '.join(APPROVAL_MODES)})")
        elif value.lower() not in APPROVAL_MODES:
            terminal.error(f"approval must be one of: {', '.join(APPROVAL_MODES)}")
        else:
            config = replace(config, approval=value.lower())
            terminal.print(f"Approval set to {value.lower()}")
        return session, config, False
    if command == "/status":
        _show_settings(config, session, terminal)
        return session, config, False
    if command == "/diff":
        _show_diff(config, terminal)
        return session, config, False
    if command == "/clear":
        terminal.clear()
        return session, config, False
    terminal.error(f"Unknown or incomplete command: {prompt}")
    return session, config, False


def _show_settings(config: Config, session: Session | None, terminal: Terminal) -> None:
    terminal.print(f"model       {config.model}")
    terminal.print(f"reasoning   {config.reasoning}")
    terminal.print(f"approval    {config.approval}")
    terminal.print(f"endpoint    {config.endpoint}")
    terminal.print(f"workspace   {config.resolved_workspace}")
    terminal.print(f"session     {session.id if session else 'none'}")


def _show_session(session: Session | None, terminal: Terminal) -> None:
    if session is None:
        terminal.print("No active session yet")
        return
    terminal.print(f"id          {session.id}")
    terminal.print(f"name        {session.title}")
    terminal.print(f"workspace   {session.workspace}")
    terminal.print(f"messages    {len(session.messages)}")
    terminal.print(f"tokens      {session.usage.get('total_tokens', 0)}")
    terminal.print(f"updated     {session.updated_at}")


def _list_models(config: Config, terminal: Terminal) -> None:
    if not config.api_key:
        terminal.print("No API key configured; set one with /login or CODEIFY_API_KEY")
        return
    try:
        values = ResponsesClient(config.api_key, config.endpoint, config.timeout).list_models()
    except Exception as exc:
        terminal.error(str(exc))
        return
    if not values:
        terminal.print("No models returned by the endpoint")
        return
    for item in values:
        model_id = item.get("id") if isinstance(item, dict) else item
        terminal.print(str(model_id))


def _export_session(session: Session | None, value: str, config: Config, terminal: Terminal) -> None:
    if session is None:
        terminal.error("No active session to export")
        return
    target = Path(value).expanduser() if value else config.resolved_workspace / f"codeify-{session.id}.html"
    if not target.suffix:
        target = target.with_suffix(".html")
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.suffix.lower() == ".html":
        target.write_text(_session_html(session), encoding="utf-8")
    elif target.suffix.lower() == ".jsonl":
        rows = [{"type": "session", "session": session.as_dict()}]
        rows.extend({"type": "message", "message": message} for message in session.messages)
        target.write_text("\n".join(json.dumps(row, ensure_ascii=True) for row in rows) + "\n", encoding="utf-8")
    else:
        target.write_text(json.dumps(session.as_dict(), indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    terminal.print(f"Exported session to {target}")


def _session_html(session: Session) -> str:
    blocks = []
    for message in session.messages:
        role = html.escape(str(message.get("role", "message")))
        content = html.escape(str(message.get("content", "")))
        blocks.append(f"<article><h2>{role}</h2><pre>{content}</pre></article>")
    return "<!doctype html><meta charset=\"utf-8\"><title>Codeify session</title><style>body{font:16px system-ui;max-width:960px;margin:40px auto;padding:0 20px}article{border-top:1px solid #ddd;padding:16px 0}pre{white-space:pre-wrap}</style>" + "".join(blocks)


def _import_session(value: str, config: Config, terminal: Terminal) -> Session | None:
    if not value:
        terminal.error("Usage: /import PATH")
        return None
    path = Path(value).expanduser()
    try:
        raw = path.read_text(encoding="utf-8")
        try:
            parsed: Any = json.loads(raw)
        except json.JSONDecodeError:
            parsed = [json.loads(line) for line in raw.splitlines() if line.strip()]
    except (OSError, ValueError) as exc:
        terminal.error(f"Unable to import session: {exc}")
        return None
    data = parsed.get("session") if isinstance(parsed, dict) and isinstance(parsed.get("session"), dict) else parsed
    if isinstance(parsed, list):
        session_rows = [row.get("session") for row in parsed if isinstance(row, dict) and isinstance(row.get("session"), dict)]
        data = session_rows[0] if session_rows else None
    if not isinstance(data, dict):
        terminal.error("Import file does not contain a Codeify session")
        return None
    try:
        imported = Session.from_dict(data)
    except (TypeError, KeyError, ValueError) as exc:
        terminal.error(f"Invalid session export: {exc}")
        return None
    imported.id = Session.create(config.resolved_workspace, config.model, config.endpoint).id
    imported.workspace = str(config.resolved_workspace)
    imported.endpoint = config.endpoint
    imported.response_id = None
    imported.replay_input = _transcript_input(imported.messages)
    SessionStore().save(imported)
    terminal.print(f"Imported session {imported.id}")
    return imported


def _share_session(session: Session | None, config: Config, terminal: Terminal) -> None:
    if session is None:
        terminal.error("No active session to share")
        return
    gh = shutil.which("gh")
    if not gh:
        terminal.error("GitHub CLI is required for /share")
        return
    with tempfile.NamedTemporaryFile("w", suffix=".md", encoding="utf-8", delete=False) as handle:
        handle.write(f"# Codeify session {session.id}\n\n")
        for message in session.messages:
            handle.write(f"## {message.get('role', 'message')}\n\n{message.get('content', '')}\n\n")
        path = handle.name
    try:
        result = subprocess.run([gh, "gist", "create", "-d", f"Codeify session {session.id}", path], capture_output=True, text=True, check=False)
    finally:
        Path(path).unlink(missing_ok=True)
    if result.returncode != 0:
        terminal.error(result.stderr.strip() or "Unable to create GitHub gist")
    else:
        terminal.print(result.stdout.strip())


def _copy_last_message(session: Session | None, terminal: Terminal) -> None:
    if session is None:
        terminal.error("No active session")
        return
    messages = [message.get("content", "") for message in session.messages if message.get("role") == "assistant"]
    if not messages:
        terminal.error("No agent message to copy")
        return
    commands = (("pbcopy",), ("wl-copy",), ("xclip", "-selection", "clipboard"))
    for command in commands:
        if shutil.which(command[0]):
            result = subprocess.run(list(command), input=str(messages[-1]), text=True, capture_output=True, check=False)
            if result.returncode == 0:
                terminal.print("Copied the last agent message")
                return
    terminal.error("No supported clipboard command found")


def _clone_session(session: Session | None, config: Config, terminal: Terminal, label: str) -> Session | None:
    if session is None:
        terminal.error("No active session")
        return None
    clone = Session.create(config.resolved_workspace, session.model, session.endpoint)
    clone.title = f"{label} {session.title}"
    clone.messages = [dict(message) for message in session.messages]
    clone.usage = dict(session.usage)
    clone.response_id = session.response_id
    clone.replay_input = [dict(item) for item in session.replay_input]
    SessionStore().save(clone)
    terminal.print(f"{label} session {clone.id}")
    return clone


def _show_tree(session: Session | None, config: Config, terminal: Terminal) -> None:
    values = SessionStore().list(limit=20, workspace=config.resolved_workspace)
    if not values:
        terminal.print("No saved sessions")
        return
    for item in values:
        marker = "*" if session and item.id == session.id else " "
        terminal.print(f"{marker} {item.id}  {item.updated_at}  {item.title}")


def _login(value: str, config: Config, terminal: Terminal) -> Config:
    try:
        key = value or getpass.getpass("Codeify API key: ").strip()
    except (EOFError, KeyboardInterrupt):
        terminal.print("Login cancelled")
        return config
    if not key:
        terminal.error("An API key is required")
        return config
    path = save_config({"api_key": key})
    terminal.print(f"Logged in; saved credentials to {path}")
    return replace(config, api_key=key, auth_source="config")


def _resume_session(value: str, config: Config, terminal: Terminal) -> Session | None:
    try:
        store = SessionStore()
        session = store.load(value) if value else store.latest(config.resolved_workspace)
        if Path(session.workspace).resolve() != config.resolved_workspace:
            raise ValueError(f"Session belongs to a different workspace: {session.workspace}")
    except ValueError as exc:
        terminal.error(str(exc))
        return None
    terminal.print(f"Resumed session {session.id}: {session.title}")
    return session


def _compact_session(session: Session | None, instructions: str, config: Config, terminal: Terminal) -> None:
    if session is None:
        terminal.error("No active session to compact")
        return
    context = _transcript_input(session.messages, instructions)
    session.response_id = None
    session.replay_input = context
    session.updated_at = utc_now()
    SessionStore().save(session)
    terminal.print(f"Compacted {len(session.messages)} messages; the next prompt will rebuild context")


def _transcript_input(messages: list[dict[str, Any]], instructions: str = "") -> list[dict[str, str]]:
    parts = [f"{message.get('role', 'message')}: {message.get('content', '')}" for message in messages]
    transcript = "\n\n".join(parts)[-30000:]
    prefix = "Continue this coding session from the compacted transcript below. Preserve important decisions and repository context."
    if instructions:
        prefix += f" Compaction instructions: {instructions}"
    return [{"role": "user", "content": f"{prefix}\n\n{transcript}"}]


def _show_diff(config: Config, terminal: Terminal) -> None:
    policy = ApprovalPolicy(config.approval, interactive=True, ask=terminal.approval)
    registry = ToolRegistry(config.resolved_workspace, policy, default_timeout=config.timeout)
    result = registry.execute("git_diff", {})
    if result.output:
        terminal.print(result.output)
    elif result.ok:
        terminal.print("Working tree is clean")
    else:
        terminal.error(result.output or "Unable to read git diff")


def _show_changelog(terminal: Terminal) -> None:
    path = Path(__file__).resolve().parents[2] / "CHANGELOG.md"
    if path.is_file():
        terminal.print(path.read_text(encoding="utf-8")[:12000])
    else:
        terminal.print(f"Codeify v{__version__}\nNo changelog has been published yet.")
