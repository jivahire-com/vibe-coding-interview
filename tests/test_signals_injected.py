"""Tests for llm_eval's timeline/chat readers (still used by the LLM
Communication evaluator). The old `_gather_signals` aggregator moved to
`grader/signals.py` and is covered in `test_signals.py`.
"""
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

import json  # noqa: E402

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
        "VALUES (?, ?, 'c@test.com', 'cpp-thread-safe-cache', ?, 'active')",
        (sid, f"KEY-{sid}", f"interview/{sid}"),
    )


def test_chat_log_from_db_returns_prompts_in_ts_order():
    sid = "sig-chat-log"
    _seed_session(sid)
    execute("INSERT INTO chat_exchanges (session_id, ts, model, prompt_tokens, completion_tokens, "
            "cost_usd, prompt_text) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (sid, 2000, "m", 200, 80, 0.02, "what hidden tests might exist?"))
    execute("INSERT INTO chat_exchanges (session_id, ts, model, prompt_tokens, completion_tokens, "
            "cost_usd, prompt_text) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (sid, 1000, "m", 100, 50, 0.01, "fix lru_cache.hpp"))

    chat = llm_eval._chat_log_from_db(sid)
    assert [c["prompt_text"] for c in chat] == ["fix lru_cache.hpp", "what hidden tests might exist?"]
    assert [c["sequence"] for c in chat] == [1, 2]


def test_unified_timeline_merges_chats_and_telemetry_in_ts_order():
    sid = "sig-timeline"
    _seed_session(sid)
    execute("INSERT INTO chat_exchanges (session_id, ts, model, prompt_tokens, completion_tokens, "
            "cost_usd, prompt_text) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (sid, 1500, "m", 100, 50, 0.01, "fix this"))
    for ts, evt, payload in [
        (1000, "file_open", json.dumps({"file": "a.cpp"})),
        (2000, "edit_ai_applied", json.dumps({"file": "a.cpp", "chars": 32})),
        (1200, "edit_typed", json.dumps({"file": "a.cpp", "chars": 10})),
    ]:
        execute("INSERT INTO telemetry (session_id, ts, event_type, payload) VALUES (?, ?, ?, ?)",
                (sid, ts, evt, payload))

    timeline = llm_eval._unified_timeline_from_db(sid)
    assert [e["event_type"] for e in timeline] == ["file_open", "edit_typed", "chat", "edit_ai_applied"]
    assert [e["sequence"] for e in timeline] == [1, 2, 3, 4]
