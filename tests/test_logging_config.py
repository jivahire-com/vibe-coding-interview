"""Unit tests for the JSON formatter, contextvars, and FastAPI middleware."""
from __future__ import annotations

import io
import json
import logging
import os
import tempfile

# env must be set before any vibe import.
os.environ.setdefault("OPENAI_API_KEY", "sk-test")
os.environ.setdefault("GITHUB_BOT_PAT", "ghp-test")
os.environ.setdefault("ADMIN_TOKEN", "admin-secret")

import pytest

from vibe.logging_config import (
    JsonFormatter,
    bind_session,
    configure_logging,
    log_context,
    request_id_middleware,
)


def _emit(level: int, msg: str, *, name: str = "test", **extra) -> str:
    """Format a single record through JsonFormatter and return the JSON string."""
    record = logging.LogRecord(
        name=name, level=level, pathname=__file__, lineno=0,
        msg=msg, args=(), exc_info=None,
    )
    for k, v in extra.items():
        setattr(record, k, v)
    return JsonFormatter("test-service").format(record)


def test_formatter_emits_required_fields():
    out = json.loads(_emit(logging.INFO, "hello"))
    assert out["service"] == "test-service"
    assert out["level"] == "INFO"
    assert out["logger"] == "test"
    assert out["message"] == "hello"
    assert isinstance(out["ts"], int) and out["ts"] > 1_700_000_000_000


def test_formatter_includes_extra_context_dict():
    out = json.loads(_emit(logging.WARNING, "x", context={"a": 1, "b": "c"}))
    assert out["context"] == {"a": 1, "b": "c"}


def test_formatter_ignores_non_dict_context():
    """A caller fat-fingering `extra={'context': 'just a string'}` should not
    crash — the field is dropped rather than serialised in a confusing shape."""
    out = json.loads(_emit(logging.INFO, "x", context="oops"))
    assert "context" not in out


def test_formatter_attaches_exception_trace():
    try:
        raise ValueError("boom")
    except ValueError:
        import sys
        record = logging.LogRecord(
            name="t", level=logging.ERROR, pathname=__file__, lineno=0,
            msg="caught", args=(), exc_info=sys.exc_info(),
        )
        out = json.loads(JsonFormatter("s").format(record))
    assert "ValueError: boom" in out["exception"]


def test_log_context_binds_and_unwinds():
    """contextvars set inside the block are visible to records emitted there,
    and reset cleanly on exit (including in the face of nested blocks)."""
    assert "session_id" not in json.loads(_emit(logging.INFO, "outer"))

    with log_context(session_id="s1", request_id="r1"):
        rec = json.loads(_emit(logging.INFO, "inner"))
        assert rec["session_id"] == "s1"
        assert rec["request_id"] == "r1"

        with log_context(session_id="s2"):
            rec2 = json.loads(_emit(logging.INFO, "nested"))
            assert rec2["session_id"] == "s2"
            assert rec2["request_id"] == "r1"  # untouched by inner block

        # Outer scope restored after inner unwinds
        assert json.loads(_emit(logging.INFO, "post"))["session_id"] == "s1"

    # Fully unwound
    assert "session_id" not in json.loads(_emit(logging.INFO, "after"))


def test_log_context_rejects_unknown_key():
    with pytest.raises(KeyError):
        with log_context(not_a_real_key="x"):  # type: ignore[arg-type]
            pass


def test_bind_session_sets_contextvar():
    """bind_session has no paired reset — it's request-scoped via the per-task
    contextvar copy. Verify it's observable until explicitly cleared."""
    bind_session("S-AUTH")
    try:
        out = json.loads(_emit(logging.INFO, "x"))
        assert out["session_id"] == "S-AUTH"
    finally:
        bind_session(None)


def test_configure_logging_writes_to_file_and_stdout(capsys):
    with tempfile.TemporaryDirectory() as tmp:
        configure_logging("smoke", log_dir=tmp, level="DEBUG")
        logging.getLogger("vibe.test").info("ping", extra={"context": {"n": 7}})

        log_file = os.path.join(tmp, "smoke.log")
        with open(log_file) as fh:
            line = fh.read().strip().splitlines()[-1]
        rec = json.loads(line)
        assert rec["service"] == "smoke"
        assert rec["message"] == "ping"
        assert rec["context"] == {"n": 7}

        # Stdout received the same line (captured by pytest's capsys).
        captured = capsys.readouterr().err + capsys.readouterr().out
        # configure_logging uses StreamHandler() which defaults to stderr.
        # The earlier read consumed err; combine err+out across two reads
        # is empty — re-emit to confirm stream-handler still wired.
        # (capsys may not capture stderr written before its setup; a second
        # emit + read avoids that race.)
        logging.getLogger("vibe.test").info("ping2")
        captured2 = capsys.readouterr()
        assert "ping2" in (captured2.err + captured2.out)


def test_configure_logging_is_idempotent(capsys):
    """Calling twice must not double-attach handlers, else every record
    duplicates and the file grows twice as fast."""
    with tempfile.TemporaryDirectory() as tmp:
        configure_logging("idem", log_dir=tmp)
        configure_logging("idem", log_dir=tmp)
        logging.getLogger("vibe.test").info("once")
        with open(os.path.join(tmp, "idem.log")) as fh:
            lines = [ln for ln in fh.read().splitlines() if "once" in ln]
        assert len(lines) == 1


# ── middleware ───────────────────────────────────────────────────────────────


class _FakeRequest:
    def __init__(self, headers=None, method="GET", path="/x"):
        self.headers = headers or {}
        self.method = method
        from types import SimpleNamespace
        self.url = SimpleNamespace(path=path)


class _FakeResponse:
    def __init__(self, status_code=200):
        self.status_code = status_code
        self.headers: dict[str, str] = {}


async def test_middleware_sets_response_header_and_logs(caplog):
    """X-Request-ID is echoed back and an access log line is emitted."""
    async def call_next(req):
        return _FakeResponse(200)

    with caplog.at_level(logging.INFO, logger="vibe.http"):
        resp = await request_id_middleware(_FakeRequest(), call_next)
    assert "X-Request-ID" in resp.headers
    assert any("/x 200" in r.message for r in caplog.records)


async def test_middleware_uses_incoming_request_id(caplog):
    """If the client supplied an X-Request-ID, we propagate it rather than
    generating a new one — critical for stitching client+server logs."""
    async def call_next(req):
        return _FakeResponse(200)

    with caplog.at_level(logging.INFO, logger="vibe.http"):
        resp = await request_id_middleware(
            _FakeRequest(headers={"x-request-id": "client-supplied-123"}),
            call_next,
        )
    assert resp.headers["X-Request-ID"] == "client-supplied-123"


async def test_middleware_logs_unhandled_exceptions_and_reraises(caplog):
    async def call_next(req):
        raise RuntimeError("server kaboom")

    with caplog.at_level(logging.ERROR, logger="vibe.http"):
        with pytest.raises(RuntimeError):
            await request_id_middleware(_FakeRequest(method="POST", path="/api/x"),
                                       call_next)
    # The ERROR record should include the path and a traceback.
    err_records = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert err_records
    assert "/api/x EXCEPTION" in err_records[0].message
    assert err_records[0].exc_info is not None
