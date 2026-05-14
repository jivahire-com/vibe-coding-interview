import json
import os
import tempfile
from unittest.mock import MagicMock

import pytest

_db_fd, _db_path = tempfile.mkstemp(suffix=".db")
os.environ.setdefault("OPENAI_API_KEY", "sk-test")
os.environ.setdefault("GITHUB_BOT_PAT", "ghp-test")
os.environ["GITHUB_CHALLENGES_OWNER"] = ""
os.environ.setdefault("GITHUB_CHALLENGES_REPO", "test-org/test-repo")
os.environ.setdefault("ADMIN_TOKEN", "admin-secret")
os.environ.setdefault("DB_PATH", _db_path)
os.environ.setdefault("LLM_BASE_URL", "https://openrouter.ai/api/v1")

from vibe.db import bootstrap, execute, query  # noqa: E402
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


def _make_mock_client(score: int = 7, analysis: str = "looks good") -> MagicMock:
    mock_client = MagicMock()
    content = json.dumps({"analysis": analysis, "score": score, "confidence": 0.8})
    mock_resp = MagicMock()
    mock_resp.choices[0].message.content = content
    mock_client.chat.completions.create.return_value = mock_resp
    return mock_client


def test_gather_signals_counts_telemetry():
    sid = "sig-001"
    _seed_session(sid)
    events = [
        {"ts": 1000, "event_type": "edit_batch", "payload": json.dumps({"chars": 120})},
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


def test_ai_orchestration_prompt_includes_behavioral_signals():
    sid = "sig-002"
    _seed_session(sid)
    execute(
        "INSERT INTO telemetry (session_id, ts, event_type, payload) VALUES (?, ?, ?, ?)",
        (sid, 1000, "edit_pasted", json.dumps({"chars": 900, "suspicious_paste": False})),
    )
    execute(
        "INSERT INTO telemetry (session_id, ts, event_type, payload) VALUES (?, ?, ?, ?)",
        (sid, 1001, "edit_batch", json.dumps({"chars": 100})),
    )

    signals = llm_eval._gather_signals(sid, [{"prompt_text": "how do I fix this?", "correction_loop": True}])
    mock_client = _make_mock_client()

    ctx = {
        "id": "cpp-lru-cache",
        "title": "LRU Cache",
        "description": "",
        "language": "cpp",
        "code_fence": "cpp",
        "starter_code_note": "",
    }

    llm_eval._eval_ai_orchestration(mock_client, ctx, "int x = 1;", [{"prompt_text": "fix this"}], signals, sid)

    call_args = mock_client.chat.completions.create.call_args
    prompt_sent = call_args[1]["messages"][0]["content"]

    assert "BEHAVIORAL SIGNALS" in prompt_sent
    assert "Paste%" in prompt_sent
    assert "Correction loops" in prompt_sent
