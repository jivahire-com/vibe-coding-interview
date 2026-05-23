"""Tests for `llm_eval._gather_signals` — the helper that aggregates
per-session telemetry + chat-exchange counters that the LLM evaluators
include in their grading prompts.

(Tests for the old `_eval_ai_orchestration` evaluator were removed when the
dimension was split into Verification Discipline + AI Judgment per the
rubric overhaul; LLM-Communication's structured-output prompt is now covered
in `test_grading_dimensions.py`.)
"""
import json
import os
import tempfile

import pytest

_db_fd, _db_path = tempfile.mkstemp(suffix=".db")
os.environ.setdefault("OPENAI_API_KEY", "sk-test")
os.environ.setdefault("GITHUB_BOT_PAT", "ghp-test")
os.environ["GITHUB_CHALLENGES_OWNER"] = ""
os.environ.setdefault("GITHUB_CHALLENGES_REPO", "test-org/test-repo")
os.environ.setdefault("ADMIN_TOKEN", "admin-secret")
os.environ.setdefault("DB_PATH", _db_path)
os.environ.setdefault("LLM_BASE_URL", "https://openrouter.ai/api/v1")

from vibe.db import bootstrap, execute  # noqa: E402
from vibe.grader import llm_eval  # noqa: E402

bootstrap()


@pytest.fixture(autouse=True)
def _clean():
    for tbl in ("grading_errors", "grades", "jobs", "chat_exchanges", "telemetry", "sessions"):
        execute(f"DELETE FROM {tbl}")
    yield


def _seed_session(sid: str) -> None:
    execute(
        "INSERT INTO sessions (id, session_key, candidate_email, challenge_id, branch_name, status) "
        "VALUES (?, ?, 'c@test.com', 'cpp-lru-cache', ?, 'active')",
        (sid, f"KEY-{sid}", f"interview/{sid}"),
    )


def test_gather_signals_counts_telemetry():
    sid = "sig-001"
    _seed_session(sid)
    events = [
        # `edit_typed` is the canonical typed-edit event since the rubric
        # overhaul — the older `edit_batch` event is no longer emitted.
        {"ts": 1000, "event_type": "edit_typed", "payload": json.dumps({"chars": 120})},
        {"ts": 2000, "event_type": "edit_pasted", "payload": json.dumps({"chars": 80, "suspicious_paste": True})},
        {"ts": 3000, "event_type": "app_focused", "payload": json.dumps({"time_away_seconds": 5.0})},
        {"ts": 4000, "event_type": "app_focused", "payload": json.dumps({"time_away_seconds": 2.0})},
    ]
    for e in events:
        execute(
            "INSERT INTO telemetry (session_id, ts, event_type, payload) VALUES (?, ?, ?, ?)",
            (sid, e["ts"], e["event_type"], e["payload"]),
        )

    signals = llm_eval._gather_signals(sid, [])

    assert signals["typed_chars"] == 120
    assert signals["pasted_chars"] == 80
    assert signals["window_switches"] == 2
    assert signals["suspicious_pastes"] == 1
    assert signals["paste_pct"] == pytest.approx(40.0, abs=0.1)


def test_gather_signals_counts_correction_loops_from_chat_log():
    sid = "sig-corr"
    _seed_session(sid)
    chat_log = [
        {"prompt_text": "first", "correction_loop": False},
        {"prompt_text": "wrong, retry", "correction_loop": True},
        {"prompt_text": "still wrong", "correction_loop": True},
    ]
    signals = llm_eval._gather_signals(sid, chat_log)
    assert signals["correction_loops"] == 2


def test_chat_log_from_db_returns_prompts_in_ts_order(tmp_path):
    """chat_exchanges is the sole source for the LLM Communication evaluator
    since the on-branch JSON file was retired. Two prompts in must produce two
    chat entries out, in timestamp order, with sequence 1/2."""
    sid = "sig-chat-log"
    _seed_session(sid)
    execute(
        "INSERT INTO chat_exchanges (session_id, ts, model, prompt_tokens, "
        "completion_tokens, cost_usd, prompt_text) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (sid, 2000, "claude-sonnet-4.6", 200, 80, 0.02, "what hidden tests might exist?"),
    )
    execute(
        "INSERT INTO chat_exchanges (session_id, ts, model, prompt_tokens, "
        "completion_tokens, cost_usd, prompt_text) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (sid, 1000, "claude-sonnet-4.6", 100, 50, 0.01, "fix lru_cache.hpp"),
    )

    chat = llm_eval._chat_log_from_db(sid)

    assert len(chat) == 2
    assert [c["prompt_text"] for c in chat] == [
        "fix lru_cache.hpp", "what hidden tests might exist?",
    ]
    assert [c["sequence"] for c in chat] == [1, 2]
    assert all(c["event_type"] == "chat" for c in chat)


def test_unified_timeline_merges_chats_and_telemetry_in_ts_order(tmp_path):
    """The unified timeline (used for "test ran 45s after AI apply" evidence)
    merges chat_exchanges + telemetry rows by ts, with sequence assigned
    in chronological order."""
    sid = "sig-timeline"
    _seed_session(sid)
    execute(
        "INSERT INTO chat_exchanges (session_id, ts, model, prompt_tokens, "
        "completion_tokens, cost_usd, prompt_text) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (sid, 1500, "claude-sonnet-4.6", 100, 50, 0.01, "fix this"),
    )
    for ts, evt, payload in [
        (1000, "file_open", json.dumps({"file": "a.cpp"})),
        (2000, "edit_ai_applied", json.dumps({"file": "a.cpp", "chars": 32})),
        (1200, "edit_typed", json.dumps({"file": "a.cpp", "chars": 10})),
    ]:
        execute(
            "INSERT INTO telemetry (session_id, ts, event_type, payload) VALUES (?, ?, ?, ?)",
            (sid, ts, evt, payload),
        )

    timeline = llm_eval._unified_timeline_from_db(sid)

    assert [e["event_type"] for e in timeline] == [
        "file_open", "edit_typed", "chat", "edit_ai_applied",
    ]
    assert [e["sequence"] for e in timeline] == [1, 2, 3, 4]
