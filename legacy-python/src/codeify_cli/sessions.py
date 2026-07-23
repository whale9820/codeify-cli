from __future__ import annotations

import json
import os
import re
import tempfile
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import default_config_dir


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sessions_dir() -> Path:
    return default_config_dir() / "sessions"


@dataclass
class Session:
    id: str
    created_at: str
    updated_at: str
    workspace: str
    model: str
    endpoint: str
    title: str = "New session"
    response_id: str | None = None
    messages: list[dict[str, Any]] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)
    replay_input: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def create(cls, workspace: Path, model: str, endpoint: str, prompt: str | None = None) -> "Session":
        now = utc_now()
        title = title_from_prompt(prompt) if prompt else "New session"
        return cls(
            id=uuid.uuid4().hex[:12],
            created_at=now,
            updated_at=now,
            workspace=str(workspace),
            model=model,
            endpoint=endpoint,
            title=title,
        )

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "Session":
        fields = {key: value[key] for key in cls.__dataclass_fields__ if key in value}
        return cls(**fields)

    def add_message(self, role: str, content: str) -> None:
        self.messages.append({"role": role, "content": content, "timestamp": utc_now()})
        self.updated_at = utc_now()

    def add_usage(self, usage: dict[str, Any] | None) -> None:
        if not usage:
            return
        for key in ("input_tokens", "output_tokens", "total_tokens"):
            value = usage.get(key)
            if isinstance(value, int):
                self.usage[key] = self.usage.get(key, 0) + value

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def title_from_prompt(prompt: str, width: int = 64) -> str:
    clean = re.sub(r"\s+", " ", prompt).strip()
    return clean if len(clean) <= width else clean[: width - 3].rstrip() + "..."


class SessionStore:
    def __init__(self, directory: Path | None = None) -> None:
        self.directory = directory or sessions_dir()

    def save(self, session: Session) -> Path:
        self.directory.mkdir(parents=True, exist_ok=True)
        target = self.directory / f"{session.id}.json"
        fd, temporary = tempfile.mkstemp(prefix=f".{session.id}.", suffix=".tmp", dir=self.directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(session.as_dict(), handle, indent=2, ensure_ascii=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return target

    def load(self, session_id: str) -> Session:
        target = self.resolve(session_id)
        try:
            data = json.loads(target.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise ValueError(f"Unable to load session {session_id}: {exc}") from exc
        return Session.from_dict(data)

    def resolve(self, session_id: str) -> Path:
        candidates = sorted(self.directory.glob(f"{session_id}*.json")) if self.directory.exists() else []
        if not candidates:
            raise ValueError(f"Session not found: {session_id}")
        if len(candidates) > 1:
            raise ValueError(f"Session ID is ambiguous: {session_id}")
        return candidates[0]

    def list(self, limit: int = 20, workspace: Path | None = None) -> list[Session]:
        if not self.directory.exists():
            return []
        sessions: list[Session] = []
        for path in self.directory.glob("*.json"):
            try:
                session = Session.from_dict(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, ValueError, TypeError):
                continue
            if workspace and Path(session.workspace).resolve() != workspace.resolve():
                continue
            sessions.append(session)
        sessions.sort(key=lambda item: item.updated_at, reverse=True)
        return sessions[:limit]

    def delete(self, session_id: str) -> Path:
        target = self.resolve(session_id)
        target.unlink()
        return target

    def latest(self, workspace: Path | None = None) -> Session:
        matches = self.list(limit=1, workspace=workspace)
        if not matches:
            raise ValueError("No saved sessions found")
        return matches[0]
