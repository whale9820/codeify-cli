from __future__ import annotations

import json
import os
import stat
import tempfile
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from . import __version__


DEFAULT_ENDPOINT = "https://codeify.cc/v1"
DEFAULT_MODEL = "gpt-5.6-sol"
DEFAULT_REASONING = "medium"
DEFAULT_APPROVAL = "ask"
CONFIG_DIR_NAME = ".codeify"
CONFIG_FILE_NAME = "config.json"


def default_config_dir() -> Path:
    configured = os.environ.get("CODEIFY_CONFIG_DIR")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / CONFIG_DIR_NAME


def find_workspace(path: str | Path | None = None) -> Path:
    candidate = Path(path or os.getcwd()).expanduser().resolve()
    if candidate.is_file():
        candidate = candidate.parent
    for current in (candidate, *candidate.parents):
        if (current / ".git").exists() or (current / "pyproject.toml").exists() or (current / "package.json").exists():
            return current
    return candidate


@dataclass(frozen=True)
class Config:
    api_key: str | None = None
    endpoint: str = DEFAULT_ENDPOINT
    model: str = DEFAULT_MODEL
    reasoning: str = DEFAULT_REASONING
    approval: str = DEFAULT_APPROVAL
    workspace: Path | None = None
    timeout: float = 120.0
    max_tool_loops: int = 80
    max_output_tokens: int | None = None
    temperature: float | None = None
    store: bool = True
    color: bool = True
    telemetry: bool = False
    source: str = "defaults"
    auth_source: str = "missing"

    @property
    def config_path(self) -> Path:
        return default_config_dir() / CONFIG_FILE_NAME

    @property
    def resolved_workspace(self) -> Path:
        return (self.workspace or find_workspace()).resolve()

    @property
    def masked_api_key(self) -> str | None:
        if not self.api_key:
            return None
        if len(self.api_key) < 10:
            return "*" * len(self.api_key)
        return f"{self.api_key[:4]}...{self.api_key[-4:]}"

    def with_overrides(self, **values: Any) -> "Config":
        clean = {key: value for key, value in values.items() if value is not None}
        if "workspace" in clean and clean["workspace"] is not None:
            clean["workspace"] = Path(clean["workspace"]).expanduser()
        return replace(self, **clean)

    def as_dict(self, redact: bool = True) -> dict[str, Any]:
        value = {
            "api_key": self.masked_api_key if redact else self.api_key,
            "endpoint": self.endpoint,
            "model": self.model,
            "reasoning": self.reasoning,
            "approval": self.approval,
            "workspace": str(self.resolved_workspace),
            "timeout": self.timeout,
            "max_tool_loops": self.max_tool_loops,
            "max_output_tokens": self.max_output_tokens,
            "temperature": self.temperature,
            "store": self.store,
            "color": self.color,
            "telemetry": self.telemetry,
            "source": self.source,
            "auth_source": self.auth_source,
            "version": __version__,
        }
        return value


def _read_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"Invalid Codeify config at {path}: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError(f"Codeify config at {path} must be a JSON object")
    return parsed


def _coerce(values: dict[str, Any], source: str, auth_source: str) -> Config:
    allowed = {"api_key", "endpoint", "model", "reasoning", "approval", "workspace", "timeout", "max_tool_loops", "max_output_tokens", "temperature", "store", "color", "telemetry"}
    values = {key: value for key, value in values.items() if key in allowed}
    if values.get("workspace"):
        values["workspace"] = Path(str(values["workspace"])).expanduser()
    if values.get("endpoint"):
        values["endpoint"] = str(values["endpoint"]).rstrip("/")
    if values.get("timeout") is not None:
        values["timeout"] = float(values["timeout"])
    if values.get("max_tool_loops") is not None:
        values["max_tool_loops"] = int(values["max_tool_loops"])
    if values.get("max_output_tokens") is not None:
        values["max_output_tokens"] = int(values["max_output_tokens"])
    if values.get("temperature") is not None:
        values["temperature"] = float(values["temperature"])
    if values.get("approval") not in {None, "ask", "auto-edit", "full-auto", "plan"}:
        raise ValueError("approval must be ask, auto-edit, full-auto, or plan")
    if values.get("reasoning") not in {None, "none", "low", "medium", "high", "xhigh", "max"}:
        raise ValueError("invalid reasoning effort")
    if values.get("timeout") is not None and values["timeout"] <= 0:
        raise ValueError("timeout must be greater than zero")
    if values.get("max_tool_loops") is not None and values["max_tool_loops"] <= 0:
        raise ValueError("max_tool_loops must be greater than zero")
    return Config(source=source, auth_source=auth_source, **values)


def load_config(overrides: dict[str, Any] | None = None) -> Config:
    path = default_config_dir() / CONFIG_FILE_NAME
    file_values = _read_file(path)
    overrides = overrides or {}
    env_values: dict[str, Any] = {}
    env_map = {
        "CODEIFY_MODEL": "model",
        "CODEIFY_REASONING": "reasoning",
        "CODEIFY_APPROVAL": "approval",
        "CODEIFY_WORKSPACE": "workspace",
        "CODEIFY_TIMEOUT": "timeout",
        "CODEIFY_MAX_TOOL_LOOPS": "max_tool_loops",
    }
    for env_name, key in env_map.items():
        if os.environ.get(env_name):
            env_values[key] = os.environ[env_name]
    if os.environ.get("CODEIFY_BASE_URL"):
        env_values["endpoint"] = os.environ["CODEIFY_BASE_URL"]
    elif os.environ.get("OPENAI_BASE_URL"):
        env_values["endpoint"] = os.environ["OPENAI_BASE_URL"]
    if os.environ.get("CODEIFY_API_KEY"):
        env_values["api_key"] = os.environ["CODEIFY_API_KEY"]
        auth_source = "environment:CODEIFY_API_KEY"
    elif os.environ.get("OPENAI_API_KEY"):
        env_values["api_key"] = os.environ["OPENAI_API_KEY"]
        auth_source = "environment:OPENAI_API_KEY"
    elif file_values.get("api_key"):
        auth_source = "config"
    else:
        auth_source = "missing"
    values = dict(file_values)
    values.update(env_values)
    values.update(overrides)
    if overrides.get("api_key"):
        auth_source = "flag"
    source = "flag" if overrides else "environment" if env_values else "config" if file_values else "defaults"
    return _coerce(values, source, auth_source)


def save_config(values: dict[str, Any], path: Path | None = None) -> Path:
    target = path or (default_config_dir() / CONFIG_FILE_NAME)
    target.parent.mkdir(parents=True, exist_ok=True)
    existing = _read_file(target)
    for key, value in values.items():
        if value is None:
            continue
        if isinstance(value, Path):
            value = str(value)
        existing[key] = value
    _write_config(target, existing)
    return target


def unset_config(key: str, path: Path | None = None) -> Path:
    target = path or (default_config_dir() / CONFIG_FILE_NAME)
    if not target.exists():
        return target
    existing = _read_file(target)
    existing.pop(key, None)
    _write_config(target, existing)
    return target


def _write_config(target: Path, values: dict[str, Any]) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".config.", suffix=".tmp", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(values, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, stat.S_IRUSR | stat.S_IWUSR)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def doctor(config: Config) -> dict[str, Any]:
    workspace = config.resolved_workspace
    return {
        "ok": bool(config.api_key and workspace.exists()),
        "version": __version__,
        "auth": {"configured": bool(config.api_key), "source": config.auth_source, "value": config.masked_api_key},
        "endpoint": config.endpoint,
        "model": config.model,
        "workspace": {"path": str(workspace), "exists": workspace.exists(), "is_directory": workspace.is_dir()},
        "config": {"path": str(config.config_path), "exists": config.config_path.exists()},
        "network": "not_checked",
        "next": "Set CODEIFY_API_KEY or run `codeify init`" if not config.api_key else "Ready for an agent run",
    }
