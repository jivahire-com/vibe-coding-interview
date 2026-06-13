"""Tests for the developer-signal rubric (folded into the /100).

`developer_signals.score(signals, client, session_id)` returns one holistic 1-10
score plus strong/weak/missing subpoints, a 0-100 `dev_score_0_100`, a
`verdict_label` (developer / uncertain / non_developer), and a one-sentence
`reasoning`. It is a pure consumer of Layer-2 signals (signals.build).
"""
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

from vibe.db import bootstrap, execute  # noqa: E402
from vibe.grader import signals as signals_mod  # noqa: E402
from vibe.grader.developer_signals import score as dev_score  # noqa: E402

bootstrap()


@pytest.fixture(autouse=True)
def _clean():
    for tbl in ("grading_errors", "grades", "jobs", "chat_exchanges", "telemetry", "sessions"):
        execute(f"DELETE FROM {tbl}")
    yield


def _seed_session(sid, ai=1):
    execute(
        "INSERT INTO sessions (id, session_key, candidate_email, challenge_id, branch_name, status, ai_assistance) "
        "VALUES (?, ?, 'c@test.com', 'cpp-thread-safe-cache', ?, 'active', ?)",
        (sid, f"KEY-{sid}", f"interview/{sid}", ai),
    )


def _inject_event(sid, ts, event_type, payload):
    execute("INSERT INTO telemetry (session_id, ts, event_type, payload) VALUES (?, ?, ?, ?)",
            (sid, ts, event_type, json.dumps(payload)))


def _inject_chat(sid, prompt_text, ts=1):
    execute("INSERT INTO chat_exchanges (session_id, ts, model, prompt_tokens, completion_tokens, "
            "cost_usd, prompt_text) VALUES (?, ?, 'm', 0, 0, 0, ?)", (sid, ts, prompt_text))


def _mock_client(reasoning="Behavior consistent with a developer."):
    c = MagicMock()
    resp = MagicMock()
    resp.choices[0].message.content = reasoning
    c.chat.completions.create.return_value = resp
    return c


def _sig(sid, ai=True):
    return signals_mod.build(sid, ai_assistance=ai, client=None)


# ── shape / contract ──────────────────────────────────────────────────────────

def test_returns_expected_keys_and_types():
    sid = "dc-shape"
    _seed_session(sid)
    out = dev_score(_sig(sid), _mock_client(), sid)
    assert {"score", "subpoints", "verdict_label", "dev_score_0_100", "reasoning"} <= set(out)
    assert isinstance(out["score"], float)
    assert out["verdict_label"] in {"developer", "uncertain", "non_developer"}
    assert all(sp["verdict"] in {"strong", "weak", "missing"} for sp in out["subpoints"])


def test_no_telemetry_yields_non_developer():
    sid = "dc-empty"
    _seed_session(sid)
    out = dev_score(_sig(sid), _mock_client(), sid)
    assert out["dev_score_0_100"] == 0
    assert out["verdict_label"] == "non_developer"
    assert round(out["score"] * 10) == out["dev_score_0_100"]  # x10 relationship holds


def test_reasoning_uses_llm_helper():
    sid = "dc-reason"
    _seed_session(sid)
    client = _mock_client("Looks like a real engineer.")
    out = dev_score(_sig(sid), client, sid)
    client.chat.completions.create.assert_called_once()
    assert out["reasoning"] == "Looks like a real engineer."


def test_senior_developer_profile_scores_developer():
    sid = "ex-a"
    _seed_session(sid)
    for i, f in enumerate(["a", "b", "c", "d", "e", "f", "g", "h"]):
        _inject_event(sid, 100 + i, "file_open", {"file": f"{f}.cpp"})
    for i in range(10):
        _inject_event(sid, 1000 + i * 100, "edit_ai_applied", {"file": "a.cpp", "chars": 80})
    for i in range(10):
        _inject_event(sid, 1000 + i * 100 + 50, "edit_typed", {"file": "a.cpp", "chars": 64})
    for i in range(5):
        _inject_event(sid, 5000 + i, "test_run", {})
    for i in range(9):
        _inject_chat(sid, "please fix this function and return the array", ts=i)
    _inject_chat(sid, "this is broken plz help", ts=99)

    out = dev_score(_sig(sid), _mock_client(), sid)
    assert out["verdict_label"] == "developer"
    assert 60 <= out["dev_score_0_100"] <= 80


def test_debugger_bonus_lifts_and_is_reported():
    sid = "dc-dbg"
    _seed_session(sid)
    for i in range(5):
        _inject_event(sid, 100 + i, "file_open", {"file": f"{i}.cpp"})
    for i in range(3):
        _inject_event(sid, 500 + i, "test_run", {})
    _inject_event(sid, 900, "debug_session", {})
    out = dev_score(_sig(sid), _mock_client(), sid)
    dbg = next(sp for sp in out["subpoints"] if sp["key"] == "debugger_bonus")
    assert dbg["verdict"] == "strong"

    bonus = signals_mod_debugger_card(sid)
    assert bonus["attempted"] is True
    assert bonus["lifts"] == "developer signal"


def signals_mod_debugger_card(sid):
    from vibe.grader.developer_signals import debugger_bonus
    return debugger_bonus(_sig(sid))


def test_non_ai_track_uses_files_and_tests_only():
    sid = "dc-nonai"
    _seed_session(sid, ai=0)
    for i in range(5):
        _inject_event(sid, 100 + i, "file_open", {"file": f"{i}.cpp"})
    for i in range(3):
        _inject_event(sid, 500 + i, "test_run", {})
    out = dev_score(_sig(sid, ai=False), _mock_client(), sid)
    keys = {sp["key"] for sp in out["subpoints"]}
    assert keys == {"files_explored", "test_runs", "debugger_bonus"}
    # full files + tests + no debugger → 75/100 → uncertain/developer boundary
    assert out["dev_score_0_100"] == 75
