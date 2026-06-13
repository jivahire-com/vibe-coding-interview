"""Unit tests for the telemetry-file integrity check (tamper detection).

Pins the verdict matrix of vibe.grader.telemetry_integrity.check():
  - anchor + matching first line          → ok (not tampered)
  - anchor + file missing                 → deleted (tampered)
  - anchor + file present but empty        → emptied (tampered)
  - anchor + first line id/ts mismatch    → recreated (tampered)
  - no anchor recorded                     → unknown (fail open, not tampered)

The anchor is the {first_ts, first_id} the extension reports to app_logs on the
first telemetry event; deleting telemetry.jsonl forces the extension to recreate
it with a new first-event id, which no longer matches the recorded anchor.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import pytest

_db_fd, _db_path = tempfile.mkstemp(suffix=".db")
os.environ.setdefault("OPENAI_API_KEY", "sk-test")
os.environ.setdefault("GITHUB_BOT_PAT", "ghp-test")
os.environ.setdefault("GITHUB_CHALLENGES_OWNER", "")
os.environ.setdefault("GITHUB_CHALLENGES_REPO", "test-org/test-repo")
os.environ.setdefault("ADMIN_TOKEN", "admin-secret")
os.environ.setdefault("DB_PATH", _db_path)
os.environ.setdefault("LLM_BASE_URL", "https://openrouter.ai/api/v1")

from vibe.db import bootstrap, execute  # noqa: E402
from vibe.grader import runner, telemetry_integrity  # noqa: E402

bootstrap()

_TAMPER_NOTE = "Telemetry integrity violation: the record was deleted."


@pytest.fixture(autouse=True)
def _clean():
    # Child tables before `sessions` so foreign-key references don't block the
    # delete when this module shares a DB with other test modules.
    for tbl in ("app_logs", "grades", "jobs", "chat_exchanges", "telemetry", "sessions"):
        execute(f"DELETE FROM {tbl}")
    yield


def _seed_session(sid: str) -> None:
    execute(
        "INSERT INTO sessions (id, session_key, candidate_email, challenge_id, "
        " branch_name, status) VALUES (?, ?, 'c@test.com', 'python-ttl-cache', ?, 'submitted')",
        (sid, f"KEY-{sid}", f"interview/{sid}"),
    )


def _record_anchor(sid: str, *, first_ts: int, first_id: str, ts: int = 1) -> None:
    """Mimic the extension's `telemetry_anchor` log landing in app_logs."""
    execute(
        "INSERT INTO app_logs (ts, source, level, logger, message, session_id, context) "
        "VALUES (?, 'extension', 'INFO', 'extension.telemetry', 'telemetry_anchor', ?, ?)",
        (ts, sid, json.dumps({"first_ts": first_ts, "first_id": first_id, "origin": "first_event"})),
    )


def _write_jsonl(clone_dir: Path, events: list[dict]) -> None:
    d = clone_dir / ".jivahire"
    d.mkdir(parents=True, exist_ok=True)
    (d / "telemetry.jsonl").write_text(
        "".join(json.dumps(e) + "\n" for e in events)
    )


def _evt(ts: int, eid: str, etype: str = "file_open") -> dict:
    return {"ts": ts, "event_type": etype, "payload": {}, "id": eid}


# ── matching anchor → ok ──────────────────────────────────────────────────

def test_matching_first_event_is_ok(tmp_path):
    _seed_session("s1")
    _record_anchor("s1", first_ts=1000, first_id="1000.42.1")
    _write_jsonl(tmp_path, [_evt(1000, "1000.42.1"), _evt(2000, "2000.42.2")])

    result = telemetry_integrity.check("s1", tmp_path)
    assert result["tampered"] is False
    assert result["verdict"] == "ok"


# ── deletion → tampered ───────────────────────────────────────────────────

def test_missing_file_with_recorded_anchor_is_deleted(tmp_path):
    _seed_session("s2")
    _record_anchor("s2", first_ts=1000, first_id="1000.42.1")
    # No telemetry.jsonl on the branch at all.

    result = telemetry_integrity.check("s2", tmp_path)
    assert result["tampered"] is True
    assert result["verdict"] == "deleted"


def test_empty_file_with_recorded_anchor_is_emptied(tmp_path):
    _seed_session("s3")
    _record_anchor("s3", first_ts=1000, first_id="1000.42.1")
    (tmp_path / ".jivahire").mkdir(parents=True)
    (tmp_path / ".jivahire" / "telemetry.jsonl").write_text("\n  \n")

    result = telemetry_integrity.check("s3", tmp_path)
    assert result["tampered"] is True
    assert result["verdict"] == "emptied"


def test_recreated_file_with_new_first_event_is_recreated(tmp_path):
    _seed_session("s4")
    _record_anchor("s4", first_ts=1000, first_id="1000.42.1")
    # File deleted mid-session and recreated: first event now has a later ts
    # and a brand-new id that cannot match the recorded anchor.
    _write_jsonl(tmp_path, [_evt(5000, "5000.42.9"), _evt(6000, "6000.42.10")])

    result = telemetry_integrity.check("s4", tmp_path)
    assert result["tampered"] is True
    assert result["verdict"] == "recreated"
    assert "5000.42.9" in result["detail"]
    assert "1000.42.1" in result["detail"]


def test_matching_id_but_changed_ts_is_tampered(tmp_path):
    _seed_session("s5")
    _record_anchor("s5", first_ts=1000, first_id="1000.42.1")
    # Same id forged but ts edited — still a mismatch.
    _write_jsonl(tmp_path, [_evt(1234, "1000.42.1")])

    result = telemetry_integrity.check("s5", tmp_path)
    assert result["tampered"] is True
    assert result["verdict"] == "recreated"


# ── no anchor → fail open ─────────────────────────────────────────────────

def test_no_anchor_recorded_is_unknown_and_not_tampered(tmp_path):
    _seed_session("s6")
    # No telemetry_anchor in app_logs (old/offline extension, or no-show).
    _write_jsonl(tmp_path, [_evt(5000, "5000.42.9")])

    result = telemetry_integrity.check("s6", tmp_path)
    assert result["tampered"] is False
    assert result["verdict"] == "unknown"


def test_no_anchor_and_missing_file_is_unknown(tmp_path):
    _seed_session("s7")
    result = telemetry_integrity.check("s7", tmp_path)
    assert result["tampered"] is False
    assert result["verdict"] == "unknown"


def test_earliest_anchor_wins_when_reported_multiple_times(tmp_path):
    _seed_session("s8")
    # Extension re-reports the anchor on every activation; all carry the same
    # first-event values, but a later resume report must never override the
    # original. Seed the resume report first (later ts) then the original.
    _record_anchor("s8", first_ts=1000, first_id="1000.42.1", ts=50)
    _record_anchor("s8", first_ts=1000, first_id="1000.42.1", ts=10)
    _write_jsonl(tmp_path, [_evt(1000, "1000.42.1")])

    result = telemetry_integrity.check("s8", tmp_path)
    assert result["verdict"] == "ok"
    assert result["anchor"] == {"ts": 1000, "id": "1000.42.1"}



# ── runner flooring gate (three-layer rework) ─────────────────────────────

def test_floor_dims_caps_scores_and_records_note():
    note = "Telemetry integrity violation: the record was deleted."
    dims = {
        "tests": {"score": 9.0, "subpoints": []},
        "code_quality": {"score": 8.0, "subpoints": []},
        "ai_judgment": {"score": None, "subpoints": []},  # N/A on this track
    }
    runner._floor_dims(dims, list(dims.keys()), note, key="telemetry_tampered")
    assert dims["tests"]["score"] <= 0.5
    assert dims["code_quality"]["score"] <= 0.5
    assert dims["code_quality"]["note"] == note
    assert dims["code_quality"]["telemetry_tampered"] is True
    # A not-scored (N/A) dimension is left untouched.
    assert dims["ai_judgment"]["score"] is None


def test_floor_dims_no_show_leaves_objective_dims_when_excluded():
    dims = {"tests": {"score": 9.0, "subpoints": []},
            "code_quality": {"score": 8.0, "subpoints": []}}
    # No-show floors only the non-objective set (tests excluded).
    runner._floor_dims(dims, ["code_quality"], "no work submitted", key="no_show")
    assert dims["tests"]["score"] == 9.0      # objective, untouched
    assert dims["code_quality"]["score"] <= 0.5
    assert dims["code_quality"]["no_show"] is True
