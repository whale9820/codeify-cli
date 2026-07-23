from __future__ import annotations

import json
import os
import shutil
import sys
import textwrap
from dataclasses import dataclass
from typing import Any

from . import __version__
from .api import StreamEvent


class Style:
    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[38;5;244m"
    RED = "\033[38;5;167m"
    GREEN = "\033[38;5;114m"
    YELLOW = "\033[38;5;221m"
    BLUE = "\033[38;5;109m"
    MAGENTA = "\033[38;5;139m"
    CYAN = "\033[38;5;109m"
    GRAY = "\033[38;5;241m"
    BORDER = "\033[38;5;139m"
    MUTED = "\033[38;5;241m"


@dataclass
class Terminal:
    color: bool = True
    json_mode: bool = False
    quiet: bool = False

    def __post_init__(self) -> None:
        self.color = self.color and sys.stdout.isatty() and os.environ.get("NO_COLOR") is None
        self._streaming = False
        self._reasoning = False
        self._frame_active = False
        self._workspace = ""
        self._model = ""
        self._reasoning_level = ""
        self._total_tokens = 0

    def styled(self, value: str, *styles: str) -> str:
        if not self.color:
            return value
        return "".join(styles) + value + Style.RESET

    def print(self, value: str = "", *, stderr: bool = False) -> None:
        if self.quiet and not stderr:
            return
        stream = sys.stderr if stderr else sys.stdout
        print(value, file=stream, flush=True)

    def banner(self, model: str, workspace: str, reasoning: str) -> None:
        if self.json_mode or self.quiet:
            return
        self._workspace = workspace
        self._model = model
        self._reasoning_level = reasoning
        self._total_tokens = 0
        self.print(" " + self.styled(f"codeify v{__version__}", Style.BOLD, Style.BLUE))
        self.print(" " + self.styled("ctrl+c/ctrl+d", Style.MUTED) + self.styled(" interrupt/exit", Style.DIM) + self.styled(" · ", Style.DIM) + self.styled("/", Style.MUTED) + self.styled(" commands", Style.DIM) + self.styled(" · ", Style.DIM) + self.styled("!", Style.MUTED) + self.styled(" bash", Style.DIM) + self.styled(" · ", Style.DIM) + self.styled("ctrl+o", Style.MUTED) + self.styled(" more", Style.DIM))
        self.print(" " + self.styled("Press ctrl+o to show full startup help and loaded resources.", Style.MUTED))
        self.print()
        if self._is_tty:
            self._render_prompt_frame()
        else:
            self.print(self.styled(self._border(), Style.BORDER))
            self._print_footer()
            self.print()

    def begin_assistant(self) -> None:
        if self.json_mode or self.quiet:
            return
        if self._streaming:
            self.end_stream()
        sys.stdout.write(self.styled(" ", Style.BLUE))
        sys.stdout.flush()
        self._streaming = True

    def on_stream_event(self, event: StreamEvent) -> None:
        if self.json_mode or self.quiet:
            return
        event_type = str(event.data.get("type") or event.event)
        if event_type in {"response.output_text.delta", "response.refusal.delta"}:
            delta = event.data.get("delta")
            if isinstance(delta, str):
                if not self._streaming or self._reasoning:
                    if self._streaming:
                        self.end_stream()
                    self.begin_assistant()
                    self._reasoning = False
                sys.stdout.write(delta)
                sys.stdout.flush()
        elif event_type in {"response.reasoning_summary_text.delta", "response.reasoning_summary.delta"}:
            delta = event.data.get("delta")
            if isinstance(delta, str):
                if not self._reasoning:
                    if self._streaming:
                        self.end_stream()
                    sys.stdout.write(self.styled("thinking | ", Style.DIM))
                    self._streaming = True
                    self._reasoning = True
                sys.stdout.write(self.styled(delta, Style.DIM))
                sys.stdout.flush()

    def end_stream(self) -> None:
        if self._streaming:
            sys.stdout.write("\n")
            sys.stdout.flush()
        self._streaming = False
        self._reasoning = False

    def tool_start(self, name: str, arguments: dict[str, Any]) -> None:
        if self.json_mode or self.quiet:
            return
        self.end_stream()
        detail = self._tool_detail(name, arguments)
        title = self.styled(f"  {self._tool_label(name)}", Style.BOLD, Style.BLUE)
        self.print(title + (self.styled(f"  {detail}", Style.DIM) if detail else ""))

    def tool_end(self, ok: bool, output: str, duration: float) -> None:
        if self.json_mode or self.quiet:
            return
        first_line = output.strip().splitlines()[0] if output.strip() else "done"
        first_line = textwrap.shorten(first_line, width=100, placeholder="...")
        marker = "done" if ok else "error"
        style = Style.GREEN if ok else Style.RED
        self.print(self.styled(f"    {marker}", style) + self.styled(f"  {first_line}", Style.MUTED) + self.styled(f"  {duration:.1f}s", Style.DIM))

    def approval(self, tool_name: str, details: str) -> bool:
        self.end_stream()
        width = shutil.get_terminal_size((88, 24)).columns
        border = "─" * max(32, min(width - 2, 88))
        self.print(self.styled(f"  {border}", Style.YELLOW))
        self.print(self.styled(f"  approval required: {tool_name}", Style.BOLD, Style.YELLOW))
        self.print(self.styled(textwrap.shorten(details, width=max(24, width - 4), placeholder="..."), Style.MUTED))
        while True:
            try:
                answer = input(self.styled("  allow? [y/N] ", Style.BOLD, Style.YELLOW)).strip().lower()
            except EOFError:
                return False
            if answer in {"y", "yes"}:
                return True
            if answer in {"", "n", "no"}:
                return False

    def user_prompt(self) -> str | None:
        self.end_stream()
        if self._is_tty and not self._frame_active:
            self._render_prompt_frame()
        try:
            first = input("") if self._frame_active else input(self.styled("  ", Style.BLUE))
        except EOFError:
            return None
        finally:
            self._leave_prompt_frame()
        lines = [first]
        while lines[-1].endswith("\\"):
            lines[-1] = lines[-1][:-1]
            try:
                lines.append(input(self.styled("    ", Style.DIM)))
            except EOFError:
                break
        return "\n".join(lines).strip()

    def emit_json(self, value: Any) -> None:
        self.end_stream()
        print(json.dumps(value, indent=2, ensure_ascii=True, default=str))

    def error(self, message: str) -> None:
        self.end_stream()
        if self.json_mode:
            self.emit_json({"ok": False, "error": {"message": message}})
        else:
            self.print(self.styled(f"error: {message}", Style.RED), stderr=True)

    def footer(self, workspace: str, model: str, reasoning: str, total_tokens: int = 0) -> None:
        if self.json_mode or self.quiet:
            return
        self._workspace = workspace
        self._model = model
        self._reasoning_level = reasoning
        self._total_tokens = total_tokens
        if self._is_tty:
            self._render_prompt_frame()
        else:
            self._print_footer()

    def update_status(self, workspace: str, model: str, reasoning: str, total_tokens: int | None = None) -> None:
        self._workspace = workspace
        self._model = model
        self._reasoning_level = reasoning
        if total_tokens is not None:
            self._total_tokens = total_tokens

    def clear(self) -> None:
        self._frame_active = False
        if self._is_tty:
            sys.stdout.write("\033[2J\033[H")
            sys.stdout.flush()

    @property
    def _is_tty(self) -> bool:
        return sys.stdout.isatty() and not self.json_mode and not self.quiet

    @staticmethod
    def _border() -> str:
        width = shutil.get_terminal_size((88, 24)).columns
        return "─" * max(1, width)

    def _print_footer(self) -> None:
        compact_workspace = self._workspace.replace(str(os.path.expanduser("~")), "~", 1)
        self.print(self.styled(compact_workspace[: shutil.get_terminal_size((88, 24)).columns], Style.MUTED))
        self.print(self.styled(self._status_line(), Style.MUTED))

    def _status_line(self) -> str:
        width = shutil.get_terminal_size((88, 24)).columns
        left = f"{self._total_tokens / 1280:.1f}%/128k"
        right = f"{self._model} • {self._reasoning_level}"
        if len(left) + len(right) + 2 <= width:
            return left + " " * (width - len(left) - len(right)) + right
        return (left + "  " + right)[:width]

    def _render_prompt_frame(self) -> None:
        if not self._is_tty:
            return
        border = self.styled(self._border(), Style.BORDER)
        workspace = self._workspace.replace(str(os.path.expanduser("~")), "~", 1)
        sys.stdout.write(border + "\n")
        sys.stdout.write(self.styled("  ", Style.BLUE) + "\n")
        sys.stdout.write(border + "\n")
        sys.stdout.write(self.styled(workspace[: shutil.get_terminal_size((88, 24)).columns], Style.MUTED) + "\n")
        sys.stdout.write(self.styled(self._status_line(), Style.MUTED) + "\n")
        sys.stdout.write("\033[4A\033[3G")
        sys.stdout.flush()
        self._frame_active = True

    def _leave_prompt_frame(self) -> None:
        if not self._frame_active:
            return
        sys.stdout.write("\033[2K\r\033[0J\n")
        sys.stdout.flush()
        self._frame_active = False

    @staticmethod
    def _tool_detail(name: str, arguments: dict[str, Any]) -> str:
        if name == "run_command":
            return str(arguments.get("command", ""))
        if name in {"read_file", "write_file", "delete_file"}:
            return str(arguments.get("path", ""))
        if name == "search_files":
            return repr(arguments.get("query", ""))
        if name == "edit_files":
            edits = arguments.get("edits") or []
            return f"{len(edits)} edit(s)"
        if name == "move_file":
            return f"{arguments.get('source', '')} -> {arguments.get('destination', '')}"
        return ""

    @staticmethod
    def _tool_label(name: str) -> str:
        return {
            "list_files": "ls",
            "read_file": "read",
            "search_files": "grep",
            "write_file": "write",
            "edit_files": "edit",
            "move_file": "move",
            "delete_file": "delete",
            "run_command": "bash",
            "git_diff": "diff",
            "ask_user": "question",
        }.get(name, name)
