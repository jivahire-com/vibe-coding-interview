"""Tests for the client-log ingest endpoint and retention sweep.

Mirrors the pattern in test_e2e.py: env is set before any vibe import so
pydantic-settings reads the right values, and ASGITransport drives the
FastAPI app in-process. A test-local fixture wipes `app_logs` between
tests since the shared `_clean` fixture in test_e2e.py predates this table.
"""
from __future__ import annotations

import json
import os
import tempfile
import time

import pytest
import respx
from httpx import ASGITransport, AsyncClient, Response

# env must be set before vibe imports — see test_e2e.py for rationale.
_db_fd, _db_path = tempfile.mkstemp(suffix=".db")
os.environ.update({
    "OPENAI_API_KEY": "sk-test",
    "GITHUB_BOT_PAT": "ghp-test",
    "GITHUB_CHALLENGES_REPO": "test-org/test-repo",
    "GITHUB_CHALLENGES_OWNER": "",
    "ADMIN_TOKEN": "admin-secret",
    "DB_PATH": _db_path,
    "LLM_BASE_URL": "https://openrouter.ai/api/v1",
})

from vibe.main import app  # noqa: E402
from vibe.db import bootstrap, execute, query  # noqa: E402
import vibe.auth as _auth  # noqa: E402
import vibe.worker as _worker  # noqa: E402

bootstrap()

_ADMIN = {"X-Admin-Token": "admin-secret"}
_REPO = "test-org/test-repo"
_GH_REF = f"https://api.github.com/repos/{_REPO}/git/ref/heads/main"
_GH_REFS = f"https://api.github.com/repos/{_REPO}/git/refs"


@pytest.fixture(autouse=True)
def _clean():
    _auth._rate_limits.clear()
    for tbl in ("app_logs", "grading_errors", "grades", "jobs", "chat_exchanges", "telemetry", "sessions"):
        execute(f"DELETE FROM {tbl}")
    yield


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def _create_active_session(client, key: str = "LOG-001") -> str:
    """Create a session and run validate-session so it is in `active` status
    (the client log ingest endpoint accepts any authenticated session, but
    the surrounding flows we model here all assume active)."""
    with respx.mock:
        respx.get(_GH_REF).mock(return_value=Response(200, json={"object": {"sha": "abc"}}))
        respx.post(_GH_REFS).mock(return_value=Response(201))
        r = await client.post(
            "/api/v1/sessions",
            json={
                "session_key": key,
                "candidate_email": "c@test.com",
                "challenge_id": "cpp-thread-safe-cache",
            },
            headers=_ADMIN,
        )
        assert r.status_code == 201
        sid = r.json()["session_id"]
        v = await client.post("/api/v1/validate-session", json={"session_key": key})
        assert v.status_code == 200
    return sid


# ── ingest endpoint ──────────────────────────────────────────────────────────


async def test_ingest_persists_records(client):
    sid = await _create_active_session(client)
    payload = {"records": [
        {"ts": 1_700_000_000_000, "level": "info", "message": "hello",
         "logger": "ext.test", "context": {"k": 1}},
        {"ts": 1_700_000_001_000, "level": "ERROR", "message": "kaboom"},
    ]}
    r = await client.post("/api/v1/logs", json=payload,
                         headers={"Authorization": "Bearer LOG-001"})
    assert r.status_code == 204

    rows = query("SELECT * FROM app_logs ORDER BY ts")
    assert len(rows) == 2
    assert rows[0]["session_id"] == sid
    assert rows[0]["level"] == "INFO"  # normalised to upper
    assert rows[0]["source"] == "extension"
    assert rows[0]["message"] == "hello"
    assert json.loads(rows[0]["context"]) == {"k": 1}
    assert rows[1]["context"] is None  # no context → NULL, not "null"


async def test_ingest_empty_batch_is_noop(client):
    await _create_active_session(client)
    r = await client.post("/api/v1/logs", json={"records": []},
                         headers={"Authorization": "Bearer LOG-001"})
    assert r.status_code == 204
    assert query("SELECT COUNT(*) AS n FROM app_logs")[0]["n"] == 0


async def test_ingest_rejects_unauthenticated(client):
    r = await client.post("/api/v1/logs",
                         json={"records": [{"ts": 1, "level": "INFO", "message": "x"}]})
    assert r.status_code == 401


async def test_ingest_rejects_invalid_level(client):
    await _create_active_session(client)
    r = await client.post(
        "/api/v1/logs",
        json={"records": [{"ts": 1, "level": "VERBOSE", "message": "x"}]},
        headers={"Authorization": "Bearer LOG-001"},
    )
    assert r.status_code == 422


async def test_ingest_truncates_huge_message(client):
    await _create_active_session(client)
    big = "x" * 20_000
    r = await client.post(
        "/api/v1/logs",
        json={"records": [{"ts": 1, "level": "INFO", "message": big}]},
        headers={"Authorization": "Bearer LOG-001"},
    )
    assert r.status_code == 204
    row = query("SELECT message FROM app_logs")[0]
    # 8 KiB cap + truncation marker
    assert row["message"].endswith("…[truncated]")
    assert len(row["message"]) < len(big)


async def test_ingest_error_records_mirror_into_server_logs(client, caplog):
    """ERROR-level client records should appear in the server's own log
    stream so a single tail surfaces both sides of a failing flow."""
    await _create_active_session(client)
    import logging
    with caplog.at_level(logging.ERROR, logger="vibe.app_logs"):
        await client.post(
            "/api/v1/logs",
            json={"records": [{"ts": 1, "level": "ERROR",
                              "message": "ext crash",
                              "context": {"file": "chat/view.ts"}}]},
            headers={"Authorization": "Bearer LOG-001"},
        )
    assert any("ext crash" in rec.message for rec in caplog.records)


# ── admin retrieval ──────────────────────────────────────────────────────────


async def test_admin_get_lists_recent(client):
    sid = await _create_active_session(client)
    now = int(time.time() * 1000)
    payload = {"records": [
        {"ts": now - 2000, "level": "INFO", "message": "old"},
        {"ts": now, "level": "ERROR", "message": "new"},
    ]}
    await client.post("/api/v1/logs", json=payload,
                     headers={"Authorization": "Bearer LOG-001"})

    r = await client.get("/api/v1/logs",
                        headers={"Authorization": "Bearer admin-secret"})
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 2
    # Ordered DESC by ts — newest first.
    assert data[0]["message"] == "new"
    assert data[0]["session_id"] == sid


async def test_admin_get_filters(client):
    await _create_active_session(client)
    now = int(time.time() * 1000)
    await client.post(
        "/api/v1/logs",
        json={"records": [
            {"ts": now - 1000, "level": "INFO", "message": "noisy"},
            {"ts": now, "level": "ERROR", "message": "bang"},
        ]},
        headers={"Authorization": "Bearer LOG-001"},
    )
    # Filter by level
    r = await client.get("/api/v1/logs?level=ERROR",
                        headers={"Authorization": "Bearer admin-secret"})
    msgs = [row["message"] for row in r.json()]
    assert msgs == ["bang"]

    # Filter by since (epoch ms)
    r = await client.get(f"/api/v1/logs?since={now - 500}",
                        headers={"Authorization": "Bearer admin-secret"})
    assert [row["message"] for row in r.json()] == ["bang"]

    # Limit cap
    r = await client.get("/api/v1/logs?limit=1",
                        headers={"Authorization": "Bearer admin-secret"})
    assert len(r.json()) == 1


async def test_admin_get_rejects_unauthenticated(client):
    r = await client.get("/api/v1/logs")
    assert r.status_code == 401

    r = await client.get("/api/v1/logs",
                        headers={"Authorization": "Bearer wrong-token"})
    assert r.status_code == 401


async def test_admin_get_rejects_invalid_filter(client):
    r = await client.get("/api/v1/logs?level=BOGUS",
                        headers={"Authorization": "Bearer admin-secret"})
    assert r.status_code == 400


# ── retention sweep ──────────────────────────────────────────────────────────


def test_retention_deletes_records_older_than_cutoff(monkeypatch):
    """Drive the worker's retention job directly — bypasses the scheduler."""
    monkeypatch.setattr(_worker, "RETENTION_DAYS", 7)
    now_ms = int(time.time() * 1000)
    # (ts, source, level, logger, message, session_id, context)
    rows = [
        (now_ms - 30 * 86400 * 1000, "extension", "INFO", None, "old", None, None),
        (now_ms - 8 * 86400 * 1000, "extension", "INFO", None, "edge", None, None),
        (now_ms - 3 * 86400 * 1000, "extension", "INFO", None, "fresh", None, None),
        (now_ms, "extension", "INFO", None, "now", None, None),
    ]
    for r in rows:
        execute(
            "INSERT INTO app_logs (ts, source, level, logger, message, session_id, context) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            r,
        )

    _worker.app_logs_retention()

    remaining = query("SELECT message FROM app_logs ORDER BY ts")
    assert [r["message"] for r in remaining] == ["fresh", "now"]


def test_retention_swallows_db_errors(monkeypatch, caplog):
    """An exception inside the sweep must not crash the scheduler thread —
    log.exception captures it and the next tick tries again."""
    import logging
    monkeypatch.setattr(
        _worker, "immediate_transaction",
        lambda: (_ for _ in ()).throw(RuntimeError("disk full")),
    )
    with caplog.at_level(logging.ERROR):
        _worker.app_logs_retention()  # should not raise
    assert any("app_logs_retention failed" in m for m in caplog.messages)
