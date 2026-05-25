"""
Tests for the telemetry ingest pipeline:
  vibe.telemetry_ingest.apply_events  (shared helper)
  vibe.grader.telemetry_ingest.ingest (grader-side JSONL reader)
"""
import json
import os
import tempfile
from pathlib import Path

import pytest

# env must be set before vibe imports
_db_fd, _db_path = tempfile.mkstemp(suffix=".db")
os.environ.setdefault("OPENAI_API_KEY", "sk-test")
os.environ.setdefault("GITHUB_CHALLENGES_REPO", "test-org/test-repo")
os.environ.setdefault("GITHUB_CHALLENGES_OWNER", "")
os.environ.setdefault("ADMIN_TOKEN", "admin-secret")
os.environ["DB_PATH"] = _db_path

from vibe.db import bootstrap, execute, query  # noqa: E402
from vibe.telemetry_ingest import apply_events  # noqa: E402
from vibe.grader.telemetry_ingest import ingest  # noqa: E402

bootstrap()


def _make_session() -> str:
    from uuid import uuid4
    sid = str(uuid4())
    execute(
        "INSERT INTO sessions (id, session_key, candidate_email, challenge_id, status, branch_name) "
        "VALUES (?, ?, ?, ?, 'active', ?)",
        (sid, f"key-{sid[:8]}", "c@test.com", "cpp-lru-cache", f"interview/{sid[:8]}"),
    )
    return sid


@pytest.fixture(autouse=True)
def _clean():
    # Delete in FK-safe order (children before parents)
    for tbl in ("grading_errors", "grades", "jobs", "chat_exchanges", "telemetry", "sessions"):
        execute(f"DELETE FROM {tbl}")
    yield


# ── apply_events ─────────────────────────────────────────────────────────────

def test_apply_events_inserts_rows():
    sid = _make_session()
    events = [
        {"ts": 1000, "event_type": "edit_typed", "payload": {"chars": 10, "file": "a.cpp"}},
        {"ts": 2000, "event_type": "edit_pasted", "payload": {"chars": 50, "file": "a.cpp", "suspicious_paste": False}},
    ]
    apply_events(sid, events)
    rows = query("SELECT event_type FROM telemetry WHERE session_id=? ORDER BY ts", (sid,))
    assert [r["event_type"] for r in rows] == ["edit_typed", "edit_pasted"]


def test_apply_events_updates_session_counters():
    sid = _make_session()
    events = [
        {"ts": 1, "event_type": "edit_typed", "payload": {"chars": 20}},
        {"ts": 2, "event_type": "edit_pasted", "payload": {"chars": 30}},
        {"ts": 3, "event_type": "edit_ai_applied", "payload": {"chars": 100, "block_id": "b1"}},
    ]
    apply_events(sid, events)
    row = query("SELECT typed_chars, pasted_chars, ai_applied_chars FROM sessions WHERE id=?", (sid,))[0]
    assert row["typed_chars"] == 20
    assert row["pasted_chars"] == 30
    assert row["ai_applied_chars"] == 100


def test_apply_events_empty_is_noop():
    sid = _make_session()
    apply_events(sid, [])
    assert query("SELECT COUNT(*) as n FROM telemetry WHERE session_id=?", (sid,))[0]["n"] == 0


# ── grader ingest ─────────────────────────────────────────────────────────────

def _write_jsonl(clone_dir: Path, events: list[dict]) -> None:
    jivahire = clone_dir / ".jivahire"
    jivahire.mkdir(exist_ok=True)
    with (jivahire / "telemetry.jsonl").open("w") as f:
        for e in events:
            f.write(json.dumps(e) + "\n")


def test_ingest_happy_path():
    sid = _make_session()
    with tempfile.TemporaryDirectory() as tmp:
        clone_dir = Path(tmp)
        _write_jsonl(clone_dir, [
            {"ts": 100, "event_type": "edit_typed", "payload": {"chars": 5, "file": "a.cpp"}},
            {"ts": 200, "event_type": "file_open", "payload": {"file": "a.cpp"}},
        ])
        ingest(sid, clone_dir)
    rows = query("SELECT event_type FROM telemetry WHERE session_id=? ORDER BY ts", (sid,))
    assert [r["event_type"] for r in rows] == ["edit_typed", "file_open"]
    counters = query("SELECT typed_chars FROM sessions WHERE id=?", (sid,))[0]
    assert counters["typed_chars"] == 5


def test_ingest_idempotent():
    sid = _make_session()
    events = [
        {"ts": 1, "event_type": "edit_typed", "payload": {"chars": 10}},
        {"ts": 2, "event_type": "edit_pasted", "payload": {"chars": 20}},
    ]
    with tempfile.TemporaryDirectory() as tmp:
        clone_dir = Path(tmp)
        _write_jsonl(clone_dir, events)
        ingest(sid, clone_dir)
        ingest(sid, clone_dir)  # second run must not double-count
    n = query("SELECT COUNT(*) as n FROM telemetry WHERE session_id=?", (sid,))[0]["n"]
    assert n == 2
    row = query("SELECT typed_chars, pasted_chars FROM sessions WHERE id=?", (sid,))[0]
    assert row["typed_chars"] == 10
    assert row["pasted_chars"] == 20


def test_ingest_missing_file_is_noop():
    sid = _make_session()
    with tempfile.TemporaryDirectory() as tmp:
        ingest(sid, Path(tmp))
    assert query("SELECT COUNT(*) as n FROM telemetry WHERE session_id=?", (sid,))[0]["n"] == 0


def test_ingest_skips_malformed_lines():
    sid = _make_session()
    with tempfile.TemporaryDirectory() as tmp:
        clone_dir = Path(tmp)
        (clone_dir / ".jivahire").mkdir()
        with (clone_dir / ".jivahire" / "telemetry.jsonl").open("w") as f:
            f.write('{"ts": 1, "event_type": "edit_typed", "payload": {"chars": 7}}\n')
            f.write("NOT VALID JSON{{{\n")
            f.write('{"ts": 3, "event_type": "file_open", "payload": {"file": "x.cpp"}}\n')
        ingest(sid, clone_dir)
    rows = query("SELECT event_type FROM telemetry WHERE session_id=? ORDER BY ts", (sid,))
    assert [r["event_type"] for r in rows] == ["edit_typed", "file_open"]
