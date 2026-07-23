from __future__ import annotations

import json
import socket
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Iterator

from . import __version__


class ApiError(RuntimeError):
    def __init__(self, message: str, status: int | None = None, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


@dataclass
class StreamEvent:
    event: str
    data: dict[str, Any]


def parse_sse(lines: Iterator[bytes]) -> Iterator[StreamEvent]:
    event_name = "message"
    data_lines: list[str] = []
    for raw_line in lines:
        line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
        if not line:
            if data_lines:
                payload = "\n".join(data_lines)
                if payload != "[DONE]":
                    try:
                        parsed = json.loads(payload)
                    except ValueError:
                        parsed = {"raw": payload}
                    if isinstance(parsed, dict):
                        yield StreamEvent(event_name, parsed)
            event_name = "message"
            data_lines = []
            continue
        if line.startswith(":"):
            continue
        field, _, value = line.partition(":")
        value = value[1:] if value.startswith(" ") else value
        if field == "event":
            event_name = value
        elif field == "data":
            data_lines.append(value)
    if data_lines:
        payload = "\n".join(data_lines)
        if payload != "[DONE]":
            try:
                parsed = json.loads(payload)
            except ValueError:
                parsed = {"raw": payload}
            if isinstance(parsed, dict):
                yield StreamEvent(event_name, parsed)


class ResponsesClient:
    def __init__(self, api_key: str | None, endpoint: str, timeout: float = 120.0, max_retries: int = 3) -> None:
        self.api_key = api_key
        self.endpoint = endpoint.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries

    def _url(self, path: str) -> str:
        if path.startswith("http://") or path.startswith("https://"):
            raise ApiError("Absolute request URLs are blocked; configure --endpoint and use an API-relative path")
        normalized = "/" + path.lstrip("/")
        return self.endpoint + normalized

    def _request(self, method: str, path: str, body: Any = None, stream: bool = False) -> urllib.response.addinfourl:
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {
            "Accept": "text/event-stream" if stream else "application/json",
            "Content-Type": "application/json",
            "User-Agent": f"codeify-cli/{__version__}",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        request = urllib.request.Request(self._url(path), data=data, headers=headers, method=method.upper())
        last_error: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                return urllib.request.urlopen(request, timeout=self.timeout)
            except urllib.error.HTTPError as exc:
                response_body = exc.read().decode("utf-8", errors="replace")
                try:
                    parsed_body: Any = json.loads(response_body)
                except ValueError:
                    parsed_body = response_body[:4000]
                if exc.code not in {408, 409, 429, 500, 502, 503, 504} or attempt >= self.max_retries:
                    message = self._error_message(parsed_body) or f"API request failed with HTTP {exc.code}"
                    raise ApiError(message, exc.code, parsed_body) from exc
                retry_after = exc.headers.get("Retry-After")
                delay = min(float(retry_after), 10.0) if retry_after and retry_after.isdigit() else min(2**attempt, 8)
                time.sleep(delay)
                last_error = exc
            except (urllib.error.URLError, socket.timeout, TimeoutError) as exc:
                last_error = exc
                if attempt >= self.max_retries:
                    raise ApiError(f"Unable to reach {self.endpoint}: {exc}") from exc
                time.sleep(min(2**attempt, 8))
        raise ApiError(f"API request failed: {last_error}")

    @staticmethod
    def _error_message(body: Any) -> str | None:
        if isinstance(body, dict):
            error = body.get("error")
            if isinstance(error, dict) and isinstance(error.get("message"), str):
                return error["message"]
            if isinstance(error, str):
                return error
            if isinstance(body.get("message"), str):
                return body["message"]
        return None

    def request_json(self, method: str, path: str, body: Any = None) -> Any:
        with self._request(method, path, body) as response:
            raw = response.read().decode("utf-8")
        if not raw:
            return None
        try:
            return json.loads(raw)
        except ValueError as exc:
            raise ApiError("API returned invalid JSON", body=raw[:4000]) from exc

    def create_response(self, payload: dict[str, Any], on_event: Callable[[StreamEvent], None] | None = None) -> dict[str, Any]:
        request_body = dict(payload)
        request_body["stream"] = True
        completed: dict[str, Any] | None = None
        with self._request("POST", "/responses", request_body, stream=True) as response:
            for stream_event in parse_sse(iter(response)):
                if on_event:
                    on_event(stream_event)
                event_type = stream_event.data.get("type") or stream_event.event
                if event_type in {"response.completed", "response.done"}:
                    value = stream_event.data.get("response")
                    if isinstance(value, dict):
                        completed = value
                elif event_type in {"response.failed", "error"}:
                    error = stream_event.data.get("error") or stream_event.data
                    raise ApiError(self._error_message({"error": error}) or "Response generation failed", body=error)
        if completed is None:
            raise ApiError("Response stream ended without a completed response")
        return completed

    def list_models(self) -> list[dict[str, Any]]:
        payload = self.request_json("GET", "/models")
        if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
            raise ApiError("Models endpoint returned an unexpected response", body=payload)
        return [item for item in payload["data"] if isinstance(item, dict)]

    def check(self) -> dict[str, Any]:
        started = time.monotonic()
        models = self.list_models()
        elapsed = round((time.monotonic() - started) * 1000)
        if not self.api_key:
            return {"ok": True, "latency_ms": elapsed, "model_count": len(models), "auth_verified": False, "auth_reason": "no API key configured"}
        if self.endpoint == "https://codeify.cc/v1":
            try:
                self.request_json("GET", "/me")
            except ApiError as exc:
                if exc.status in {401, 403}:
                    raise
                if exc.status != 404:
                    raise
        return {"ok": True, "latency_ms": elapsed, "model_count": len(models), "auth_verified": True}
