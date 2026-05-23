"""Structured JSON logging for the Vibe server, worker, and grader.

One module configures stdlib `logging` for all three process types. Every
record is emitted as a single-line JSON object containing:

    ts, level, service, logger, message, [context], [request_id],
    [session_id], [job_id], [exception]

Why JSON: pipe through `jq` locally and ship to any aggregator (Loki,
CloudWatch, etc.) without re-parsing. For dev visibility:

    tail -f logs/server.log | jq -r '"\\(.ts)  \\(.level)  \\(.message)"'

Bind contextual identifiers around a unit of work with `log_context()` —
every record emitted inside the `with` block will carry them automatically.
"""
from __future__ import annotations

import contextvars
import json
import logging
import logging.handlers
import os
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

_request_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)
_session_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("session_id", default=None)
_job_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("job_id", default=None)

_CONTEXT_VARS = {
    "request_id": _request_id,
    "session_id": _session_id,
    "job_id": _job_id,
}


@contextmanager
def log_context(**kwargs: str | None) -> Iterator[None]:
    """Bind identifiers (request_id / session_id / job_id) for the duration
    of the block. Nested calls stack and unwind correctly."""
    tokens: list[tuple[contextvars.ContextVar, contextvars.Token]] = []
    for name, value in kwargs.items():
        var = _CONTEXT_VARS.get(name)
        if var is None:
            raise KeyError(f"unknown log context: {name}")
        tokens.append((var, var.set(value)))
    try:
        yield
    finally:
        for var, tok in tokens:
            var.reset(tok)


def bind_session(session_id: str | None) -> None:
    """Set session_id on the current task's context without a paired reset.

    FastAPI dependencies run inside the per-request task, and contextvars
    are copied per-task, so a `set()` here is naturally scoped to the
    request that triggered the dependency. Use this from `get_session` so
    every log line inside an authenticated route carries the session_id
    without callers having to thread it through explicitly.
    """
    _session_id.set(session_id)


class JsonFormatter(logging.Formatter):
    """One-line JSON per record. Adds contextvars + any `extra={'context': ...}`."""

    def __init__(self, service: str) -> None:
        super().__init__()
        self._service = service

    def format(self, record: logging.LogRecord) -> str:
        out: dict[str, Any] = {
            "ts": int(record.created * 1000),
            "level": record.levelname,
            "service": self._service,
            "logger": record.name,
            "message": record.getMessage(),
        }
        for name, var in _CONTEXT_VARS.items():
            v = var.get()
            if v is not None:
                out[name] = v
        # `log.info("…", extra={"context": {...}})` — keep arbitrary structured
        # context in its own sub-object so grepping by `.context.*` stays
        # predictable and we don't pollute the top-level keys.
        ctx = getattr(record, "context", None)
        if isinstance(ctx, dict):
            out["context"] = ctx
        if record.exc_info:
            out["exception"] = self.formatException(record.exc_info)
        return json.dumps(out, default=str)


def configure_logging(
    service: str,
    *,
    log_dir: str | None = None,
    level: str | None = None,
) -> None:
    """Configure stdlib logging for a process. Idempotent: a second call
    replaces the handlers from the first (useful for tests / reloads)."""
    log_dir = log_dir or os.environ.get("VIBE_LOG_DIR", "logs")
    level_str = (level or os.environ.get("VIBE_LOG_LEVEL", "INFO")).upper()
    log_level = getattr(logging, level_str, logging.INFO)

    Path(log_dir).mkdir(parents=True, exist_ok=True)
    formatter = JsonFormatter(service)

    root = logging.getLogger()
    root.setLevel(log_level)
    for h in list(root.handlers):
        root.removeHandler(h)

    console = logging.StreamHandler()
    console.setFormatter(formatter)
    root.addHandler(console)

    log_file = Path(log_dir) / f"{service}.log"
    rot = logging.handlers.RotatingFileHandler(
        log_file, maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    rot.setFormatter(formatter)
    root.addHandler(rot)

    # Tame chatty third-party libs so the dev console isn't drowned in noise.
    # Bump to DEBUG explicitly if you need their wire-level traces.
    for noisy in ("urllib3", "httpx", "httpcore", "apscheduler.scheduler", "apscheduler.executors.default"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


async def request_id_middleware(request: Any, call_next: Any) -> Any:
    """FastAPI middleware: bind a request id (echoed in `X-Request-ID`),
    log one structured access record per request, and surface unhandled
    exceptions as ERROR-level structured logs before re-raising."""
    rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
    log = logging.getLogger("vibe.http")
    started = time.monotonic()
    with log_context(request_id=rid):
        try:
            response = await call_next(request)
        except Exception as e:
            duration_ms = int((time.monotonic() - started) * 1000)
            log.exception(
                f"{request.method} {request.url.path} EXCEPTION {duration_ms}ms",
                extra={"context": {
                    "method": request.method,
                    "path": request.url.path,
                    "duration_ms": duration_ms,
                    "error_class": type(e).__name__,
                }},
            )
            raise
        duration_ms = int((time.monotonic() - started) * 1000)
        log.info(
            f"{request.method} {request.url.path} {response.status_code} {duration_ms}ms",
            extra={"context": {
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "duration_ms": duration_ms,
            }},
        )
        response.headers["X-Request-ID"] = rid
        return response
