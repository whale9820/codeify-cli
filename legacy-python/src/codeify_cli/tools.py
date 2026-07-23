from __future__ import annotations

import difflib
import fnmatch
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


MAX_FILE_BYTES = 2_000_000
MAX_TOOL_OUTPUT = 40_000
IGNORED_DIRECTORIES = {".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next", ".cache", "target"}
SENSITIVE_NAMES = {".env", ".env.local", ".env.production", "id_rsa", "id_ed25519", "credentials.json", "service-account.json"}
SENSITIVE_SUFFIXES = {".pem", ".p12", ".pfx", ".key"}
MUTATING_TOOLS = {"write_file", "edit_files", "move_file", "delete_file"}
READ_ONLY_COMMANDS = {
    "pwd", "ls", "find", "rg", "grep", "sed", "head", "tail", "wc", "file", "stat", "du", "which", "whereis", "git status", "git diff", "git log", "git show", "git branch", "git rev-parse", "git ls-files", "git grep", "python --version", "python3 --version", "node --version", "npm --version", "pytest --version",
}
DANGEROUS_PATTERNS = (
    r"(?:^|[;&|]\s*)sudo\b",
    r"\brm\s+(?:-[A-Za-z]*r[A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*r)\s+(?:/|~|\$HOME)(?:\s|$)",
    r"\b(?:shutdown|reboot|halt|mkfs|fdisk)\b",
    r"\bdiskutil\s+erase",
    r"\bgit\s+(?:reset\s+--hard|clean\s+-[A-Za-z]*f|checkout\s+--|restore\s+--source)\b",
)


@dataclass
class ToolResult:
    ok: bool
    output: str
    metadata: dict[str, Any] | None = None

    def for_model(self) -> str:
        payload: dict[str, Any] = {"ok": self.ok, "output": self.output}
        if self.metadata:
            payload.update(self.metadata)
        return json.dumps(payload, ensure_ascii=True)


class ToolError(RuntimeError):
    pass


class ApprovalPolicy:
    def __init__(self, mode: str, interactive: bool, ask: Callable[[str, str], bool] | None = None) -> None:
        if mode not in {"ask", "auto-edit", "full-auto", "plan"}:
            raise ValueError(f"Unknown approval mode: {mode}")
        self.mode = mode
        self.interactive = interactive
        self.ask = ask

    def authorize(self, tool_name: str, details: str, mutating: bool, command: str | None = None) -> None:
        if not mutating:
            return
        if self.mode == "plan":
            raise ToolError(f"{tool_name} is disabled in plan mode")
        if self.mode == "full-auto":
            return
        if tool_name in MUTATING_TOOLS and self.mode == "auto-edit":
            return
        if command and is_read_only_command(command):
            return
        if not self.interactive or not self.ask:
            raise ToolError(f"Approval required for {tool_name}; rerun with --approval auto-edit or --approval full-auto")
        if not self.ask(tool_name, details):
            raise ToolError(f"User declined {tool_name}")


def is_read_only_command(command: str, workspace: Path | None = None) -> bool:
    normalized = re.sub(r"\s+", " ", command.strip())
    if any(token in normalized for token in (">", "|", ";", "&&", "||", "`", "$")):
        return False
    try:
        tokens = shlex.split(command)
    except ValueError:
        return False
    if any(token in {"-i", "--in-place", "-delete", "-exec", "-execdir", "-ok"} or token.startswith("--in-place=") for token in tokens):
        return False
    if tokens[:2] == ["git", "branch"] and len(tokens) > 2 and not all(token in {"--list", "--show-current", "--contains", "--no-contains", "--merged", "--no-merged", "-a", "-r", "-v", "-vv"} or token.startswith("--format=") for token in tokens[2:]):
        return False
    if workspace:
        root = workspace.resolve()
        for token in tokens:
            if token.startswith("~") or token == ".." or token.startswith("../"):
                return False
            if token.startswith("/") or ("/" in token and not token.startswith("-")):
                candidate = Path(token) if token.startswith("/") else root / token
                try:
                    candidate.resolve().relative_to(root)
                except ValueError:
                    return False
    return any(normalized == prefix or normalized.startswith(prefix + " ") for prefix in READ_ONLY_COMMANDS)


def reject_dangerous_command(command: str) -> None:
    for pattern in DANGEROUS_PATTERNS:
        if re.search(pattern, command, flags=re.IGNORECASE):
            raise ToolError("Command blocked because it can destructively affect data outside the workspace")


def truncate_output(value: str, limit: int = MAX_TOOL_OUTPUT) -> str:
    if len(value) <= limit:
        return value
    side = max(1000, (limit - 120) // 2)
    removed = len(value) - side * 2
    return f"{value[:side]}\n\n... {removed} characters omitted ...\n\n{value[-side:]}"


class ToolRegistry:
    def __init__(self, workspace: Path, approval: ApprovalPolicy, default_timeout: float = 120.0) -> None:
        self.workspace = workspace.resolve()
        self.approval = approval
        self.default_timeout = default_timeout
        self.handlers = {
            "list_files": self.list_files,
            "read_file": self.read_file,
            "search_files": self.search_files,
            "write_file": self.write_file,
            "edit_files": self.edit_files,
            "move_file": self.move_file,
            "delete_file": self.delete_file,
            "run_command": self.run_command,
            "git_diff": self.git_diff,
            "ask_user": self.ask_user,
        }

    @property
    def schemas(self) -> list[dict[str, Any]]:
        return [
            self._schema("list_files", "List files and directories under the workspace. Use this to understand project structure before editing.", {
                "path": {"type": "string", "description": "Workspace-relative directory, usually ."},
                "depth": {"type": "integer", "minimum": 1, "maximum": 8, "description": "Maximum traversal depth"},
                "include_hidden": {"type": "boolean", "description": "Include dotfiles except internal VCS data"},
            }, ["path"]),
            self._schema("read_file", "Read a UTF-8 text file with numbered lines. Read focused ranges for large files.", {
                "path": {"type": "string", "description": "Workspace-relative file path"},
                "line_start": {"type": "integer", "minimum": 1, "description": "First line to return, inclusive"},
                "line_end": {"type": "integer", "minimum": 1, "description": "Last line to return, inclusive"},
            }, ["path"]),
            self._schema("search_files", "Search text across workspace files with ripgrep-compatible regex syntax.", {
                "query": {"type": "string", "description": "Regular expression or literal text to find"},
                "path": {"type": "string", "description": "Workspace-relative search root"},
                "glob": {"type": "string", "description": "Optional file glob such as *.py"},
                "max_results": {"type": "integer", "minimum": 1, "maximum": 500, "description": "Maximum matching lines"},
            }, ["query"]),
            self._schema("write_file", "Create or fully replace one text file. Prefer edit_files for targeted changes to existing files.", {
                "path": {"type": "string", "description": "Workspace-relative file path"},
                "content": {"type": "string", "description": "Complete UTF-8 file content"},
            }, ["path", "content"]),
            self._schema("edit_files", "Apply exact text replacements to one or more files atomically. Each old_text must match exactly once unless replace_all is true.", {
                "edits": {"type": "array", "items": {"type": "object", "properties": {
                    "path": {"type": "string"},
                    "old_text": {"type": "string"},
                    "new_text": {"type": "string"},
                    "replace_all": {"type": "boolean"},
                }, "required": ["path", "old_text", "new_text"], "additionalProperties": False}},
            }, ["edits"]),
            self._schema("move_file", "Move or rename one file or directory within the workspace.", {
                "source": {"type": "string"},
                "destination": {"type": "string"},
            }, ["source", "destination"]),
            self._schema("delete_file", "Delete one file or an empty directory within the workspace.", {
                "path": {"type": "string"},
            }, ["path"]),
            self._schema("run_command", "Run a shell command in the workspace. Use for builds, tests, formatting, package operations, and version control inspection.", {
                "command": {"type": "string", "description": "Shell command to execute"},
                "cwd": {"type": "string", "description": "Workspace-relative working directory"},
                "timeout": {"type": "number", "minimum": 0.1, "maximum": 1800, "description": "Timeout in seconds"},
            }, ["command"]),
            self._schema("git_diff", "Return git status and the current unstaged and staged diffs.", {
                "path": {"type": "string", "description": "Optional workspace-relative path filter"},
            }, []),
            self._schema("ask_user", "Ask the user one blocking question only when a consequential choice cannot be inferred safely.", {
                "question": {"type": "string"},
                "options": {"type": "array", "items": {"type": "string"}, "description": "Optional short choices"},
            }, ["question"]),
        ]

    @staticmethod
    def _schema(name: str, description: str, properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
        return {
            "type": "function",
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": properties, "required": required, "additionalProperties": False},
        }

    def execute(self, name: str, arguments: dict[str, Any]) -> ToolResult:
        handler = self.handlers.get(name)
        if not handler:
            return ToolResult(False, f"Unknown tool: {name}")
        try:
            result = handler(**arguments)
            return result if isinstance(result, ToolResult) else ToolResult(True, str(result))
        except (ToolError, OSError, ValueError, subprocess.SubprocessError) as exc:
            return ToolResult(False, str(exc))
        except TypeError as exc:
            return ToolResult(False, f"Invalid arguments for {name}: {exc}")

    def resolve_path(self, raw_path: str, allow_missing: bool = False) -> Path:
        value = Path(raw_path).expanduser()
        candidate = value if value.is_absolute() else self.workspace / value
        resolved = candidate.resolve(strict=not allow_missing)
        try:
            resolved.relative_to(self.workspace)
        except ValueError as exc:
            raise ToolError(f"Path is outside the workspace: {raw_path}") from exc
        return resolved

    def ensure_readable(self, path: Path) -> None:
        if path.name in SENSITIVE_NAMES or path.suffix.lower() in SENSITIVE_SUFFIXES:
            raise ToolError(f"Reading sensitive credential file is blocked: {path.name}")
        if not path.is_file():
            raise ToolError(f"Not a file: {path.relative_to(self.workspace)}")
        if path.stat().st_size > MAX_FILE_BYTES:
            raise ToolError(f"File is too large to read ({path.stat().st_size} bytes)")

    def ensure_writable(self, path: Path) -> None:
        relative = path.relative_to(self.workspace)
        if relative.parts and relative.parts[0] == ".git":
            raise ToolError("Direct writes inside .git are blocked")
        if path.name in SENSITIVE_NAMES or path.suffix.lower() in SENSITIVE_SUFFIXES:
            raise ToolError(f"Writing sensitive credential file is blocked: {path.name}")

    def list_files(self, path: str = ".", depth: int = 3, include_hidden: bool = False) -> ToolResult:
        root = self.resolve_path(path)
        if not root.is_dir():
            raise ToolError(f"Not a directory: {path}")
        depth = max(1, min(int(depth), 8))
        output: list[str] = []
        for current, directories, files in os.walk(root):
            current_path = Path(current)
            relative_depth = len(current_path.relative_to(root).parts)
            directories[:] = sorted(name for name in directories if name not in IGNORED_DIRECTORIES and (include_hidden or not name.startswith(".")))
            if relative_depth >= depth:
                directories[:] = []
            for name in sorted(files):
                if not include_hidden and name.startswith("."):
                    continue
                item = current_path / name
                output.append(str(item.relative_to(self.workspace)))
                if len(output) >= 2000:
                    output.append("... file list truncated at 2000 entries")
                    return ToolResult(True, "\n".join(output), {"truncated": True})
        return ToolResult(True, "\n".join(output) or "No files found", {"count": len(output)})

    def read_file(self, path: str, line_start: int = 1, line_end: int | None = None) -> ToolResult:
        target = self.resolve_path(path)
        self.ensure_readable(target)
        raw = target.read_bytes()
        if b"\x00" in raw[:8192]:
            raise ToolError(f"Binary file cannot be read as text: {path}")
        text = raw.decode("utf-8", errors="replace")
        lines = text.splitlines()
        start = max(1, int(line_start))
        end = min(len(lines), int(line_end)) if line_end is not None else min(len(lines), start + 399)
        if start > len(lines) and lines:
            raise ToolError(f"line_start {start} exceeds file length {len(lines)}")
        width = len(str(max(end, 1)))
        rendered = "\n".join(f"{number:>{width}} | {lines[number - 1]}" for number in range(start, end + 1))
        return ToolResult(True, truncate_output(rendered), {"path": str(target.relative_to(self.workspace)), "lines": len(lines), "range": [start, end]})

    def search_files(self, query: str, path: str = ".", glob: str | None = None, max_results: int = 100) -> ToolResult:
        root = self.resolve_path(path)
        if root.is_file():
            self.ensure_readable(root)
        limit = max(1, min(int(max_results), 500))
        if shutil.which("rg"):
            command = ["rg", "--line-number", "--column", "--color", "never", "--max-count", str(limit)]
            if glob:
                command.extend(["--glob", glob])
            for pattern in ("!.env", "!.env.*", "!*.pem", "!*.p12", "!*.pfx", "!*.key", "!credentials.json", "!service-account.json", "!id_rsa", "!id_ed25519"):
                command.extend(["--glob", pattern])
            command.extend(["--", query, str(root)])
            completed = subprocess.run(command, cwd=self.workspace, capture_output=True, text=True, timeout=30)
            if completed.returncode not in {0, 1}:
                raise ToolError(completed.stderr.strip() or "Search failed")
            lines = completed.stdout.splitlines()[:limit]
            rendered = "\n".join(self._relative_search_line(line) for line in lines)
            return ToolResult(True, rendered or "No matches", {"count": len(lines), "truncated": len(completed.stdout.splitlines()) > limit})
        return self._python_search(query, root, glob, limit)

    def _relative_search_line(self, line: str) -> str:
        workspace = str(self.workspace) + os.sep
        return line.replace(workspace, "", 1) if line.startswith(workspace) else line

    def _python_search(self, query: str, root: Path, glob: str | None, limit: int) -> ToolResult:
        try:
            pattern = re.compile(query)
        except re.error as exc:
            raise ToolError(f"Invalid search expression: {exc}") from exc
        matches: list[str] = []
        candidates = [root] if root.is_file() else root.rglob("*")
        for candidate in candidates:
            if len(matches) >= limit:
                break
            if not candidate.is_file() or any(part in IGNORED_DIRECTORIES for part in candidate.parts):
                continue
            if glob and not fnmatch.fnmatch(candidate.name, glob):
                continue
            try:
                content = candidate.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            for number, line in enumerate(content.splitlines(), 1):
                if pattern.search(line):
                    matches.append(f"{candidate.relative_to(self.workspace)}:{number}:{line}")
                    if len(matches) >= limit:
                        break
        return ToolResult(True, "\n".join(matches) or "No matches", {"count": len(matches)})

    def write_file(self, path: str, content: str) -> ToolResult:
        target = self.resolve_path(path, allow_missing=True)
        self.ensure_writable(target)
        existed = target.exists()
        old = target.read_text(encoding="utf-8") if existed else ""
        diff = self._diff(path, old, content)
        self.approval.authorize("write_file", diff or f"Write {path}", True)
        target.parent.mkdir(parents=True, exist_ok=True)
        self._atomic_write(target, content)
        return ToolResult(True, f"{'Updated' if existed else 'Created'} {path}\n{diff}", {"path": path, "bytes": len(content.encode("utf-8"))})

    def edit_files(self, edits: list[dict[str, Any]]) -> ToolResult:
        if not edits:
            raise ToolError("At least one edit is required")
        pending: dict[Path, tuple[str, str]] = {}
        summaries: list[str] = []
        for edit in edits:
            path_text = str(edit.get("path", ""))
            target = self.resolve_path(path_text)
            self.ensure_writable(target)
            if not target.is_file():
                raise ToolError(f"Not a file: {path_text}")
            original = pending[target][1] if target in pending else target.read_text(encoding="utf-8")
            old_text = str(edit.get("old_text", ""))
            new_text = str(edit.get("new_text", ""))
            count = original.count(old_text)
            if not old_text:
                raise ToolError(f"old_text cannot be empty for {path_text}")
            if count == 0:
                raise ToolError(f"old_text was not found in {path_text}")
            replace_all = bool(edit.get("replace_all", False))
            if count > 1 and not replace_all:
                raise ToolError(f"old_text matched {count} times in {path_text}; provide more context or set replace_all")
            updated = original.replace(old_text, new_text, -1 if replace_all else 1)
            first_original = pending[target][0] if target in pending else original
            pending[target] = (first_original, updated)
        for target, (original, updated) in pending.items():
            summaries.append(self._diff(str(target.relative_to(self.workspace)), original, updated))
        details = "\n".join(summaries)
        self.approval.authorize("edit_files", truncate_output(details, 12000), True)
        for target, (_, updated) in pending.items():
            self._atomic_write(target, updated)
        return ToolResult(True, f"Edited {len(pending)} file(s)\n{truncate_output(details)}", {"files": len(pending), "edits": len(edits)})

    def move_file(self, source: str, destination: str) -> ToolResult:
        source_path = self.resolve_path(source)
        destination_path = self.resolve_path(destination, allow_missing=True)
        self.ensure_writable(source_path)
        self.ensure_writable(destination_path)
        if destination_path.exists():
            raise ToolError(f"Destination already exists: {destination}")
        self.approval.authorize("move_file", f"Move {source} to {destination}", True)
        destination_path.parent.mkdir(parents=True, exist_ok=True)
        source_path.rename(destination_path)
        return ToolResult(True, f"Moved {source} to {destination}")

    def delete_file(self, path: str) -> ToolResult:
        target = self.resolve_path(path)
        self.ensure_writable(target)
        if target.is_dir() and any(target.iterdir()):
            raise ToolError("Only empty directories can be deleted")
        self.approval.authorize("delete_file", f"Delete {path}", True)
        target.rmdir() if target.is_dir() else target.unlink()
        return ToolResult(True, f"Deleted {path}")

    def run_command(self, command: str, cwd: str = ".", timeout: float | None = None) -> ToolResult:
        reject_dangerous_command(command)
        working_directory = self.resolve_path(cwd)
        if not working_directory.is_dir():
            raise ToolError(f"Command working directory does not exist: {cwd}")
        safe_read = is_read_only_command(command, self.workspace)
        self.approval.authorize("run_command", f"$ {command}\nworking directory: {working_directory}", not safe_read)
        timeout = max(0.1, min(float(timeout if timeout is not None else self.default_timeout), 1800.0))
        started = time.monotonic()
        environment = os.environ.copy()
        for name in list(environment):
            if re.search(r"(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)", name, flags=re.IGNORECASE):
                environment.pop(name, None)
        environment["CODEIFY_AGENT"] = "1"
        process = subprocess.Popen(
            command,
            cwd=working_directory,
            shell=True,
            executable=os.environ.get("SHELL", "/bin/zsh"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
            env=environment,
        )
        timed_out = False
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGTERM)
            try:
                stdout, stderr = process.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                stdout, stderr = process.communicate()
        elapsed = round(time.monotonic() - started, 3)
        combined = stdout
        if stderr:
            combined += ("\n" if combined else "") + stderr
        combined = truncate_output(combined.rstrip())
        if timed_out:
            combined = f"Command timed out after {timeout}s\n{combined}".rstrip()
        return ToolResult(not timed_out and process.returncode == 0, combined or "Command completed with no output", {"exit_code": process.returncode, "duration_seconds": elapsed, "timed_out": timed_out})

    def git_diff(self, path: str | None = None) -> ToolResult:
        pathspec: list[str] = []
        if path:
            target = self.resolve_path(path)
            pathspec = [str(target.relative_to(self.workspace))]
        exclusions = [":(exclude)**/.env", ":(exclude)**/.env.*", ":(exclude)**/*.pem", ":(exclude)**/*.p12", ":(exclude)**/*.pfx", ":(exclude)**/*.key", ":(exclude)**/credentials.json", ":(exclude)**/service-account.json"]
        paths = ["--", *pathspec, *exclusions]
        commands = [
            ["git", "status", "--short"],
            ["git", "diff", "--no-ext-diff", *paths],
            ["git", "diff", "--cached", "--no-ext-diff", *paths],
        ]
        sections: list[str] = []
        for command in commands:
            completed = subprocess.run(command, cwd=self.workspace, capture_output=True, text=True, timeout=30)
            if completed.returncode != 0:
                if "not a git repository" in completed.stderr:
                    return ToolResult(False, "Workspace is not a Git repository")
                raise ToolError(completed.stderr.strip())
            if completed.stdout.strip():
                sections.append(f"$ {' '.join(command)}\n{completed.stdout.rstrip()}")
        return ToolResult(True, truncate_output("\n\n".join(sections) or "Working tree is clean"))

    def ask_user(self, question: str, options: list[str] | None = None) -> ToolResult:
        if not self.approval.interactive:
            raise ToolError("Cannot ask the user in non-interactive mode")
        prompt = question
        if options:
            prompt += "\n" + "\n".join(f"{index}. {value}" for index, value in enumerate(options, 1))
        answer = input(f"\n{prompt}\n> ").strip()
        return ToolResult(True, answer or "User provided no answer")

    @staticmethod
    def _diff(path: str, old: str, new: str) -> str:
        return "".join(difflib.unified_diff(old.splitlines(keepends=True), new.splitlines(keepends=True), fromfile=f"a/{path}", tofile=f"b/{path}", n=3))

    @staticmethod
    def _atomic_write(path: Path, content: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        mode = path.stat().st_mode if path.exists() else None
        fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            if mode is not None:
                os.chmod(temporary, mode)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
