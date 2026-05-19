"""Tests for the developer-confidence behavioral signal.

The four examples (A–D) mirror the worked examples in
vibe_interview_plan_enhanced.md §7.6, with the bonus narrowed to just the
debugger (goto/refs are reserved for a future iteration — they always
contribute 0 here).
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
from vibe.grader.developer_signals import compute_developer_confidence  # noqa: E402

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


def _inject_event(sid: str, ts: int, event_type: str, payload: dict) -> None:
    execute(
        "INSERT INTO telemetry (session_id, ts, event_type, payload) VALUES (?, ?, ?, ?)",
        (sid, ts, event_type, json.dumps(payload)),
    )


def _inject_chat(sid: str, prompt_text: str, ts: int = 1) -> None:
    execute(
        "INSERT INTO chat_exchanges (session_id, ts, model, prompt_tokens, completion_tokens, "
        "cost_usd, prompt_text) VALUES (?, ?, 'm', 0, 0, 0, ?)",
        (sid, ts, prompt_text),
    )


def _mock_client(reasoning: str = "Behavior consistent with a developer.") -> MagicMock:
    c = MagicMock()
    resp = MagicMock()
    resp.choices[0].message.content = reasoning
    c.chat.completions.create.return_value = resp
    return c


# ── shape / contract ──────────────────────────────────────────────────────────

def test_returns_expected_keys_and_types():
    sid = "dc-shape"
    _seed_session(sid)
    out = compute_developer_confidence(sid, _mock_client())
    assert set(out) == {"score", "verdict", "base_score", "bonus_score", "signals", "reasoning"}
    assert isinstance(out["score"], int)
    assert out["verdict"] in {"developer", "uncertain", "non_developer"}
    assert isinstance(out["signals"], dict)
    assert isinstance(out["reasoning"], str)


def test_no_telemetry_yields_non_developer():
    sid = "dc-empty"
    _seed_session(sid)
    out = compute_developer_confidence(sid, _mock_client())
    assert out["score"] == 0
    assert out["verdict"] == "non_developer"


def test_reasoning_uses_llm_helper():
    sid = "dc-reason"
    _seed_session(sid)
    client = _mock_client("Looks like a real engineer.")
    out = compute_developer_confidence(sid, client)
    client.chat.completions.create.assert_called_once()
    assert out["reasoning"] == "Looks like a real engineer."


# ── Worked examples (spec §7.6) ───────────────────────────────────────────────

def test_example_a_senior_no_debugger_uses_goto_only():
    """8 files, 80% post-AI edits, 90% specific prompts, 5 test runs, no debugger.

    Without goto/refs bonus this caps at 73 in the spec; we drop those to 0 in
    this iteration, so the score is the spec's Base 68 + Bonus 0 = 68
    (still 'developer').
    """
    sid = "ex-a"
    _seed_session(sid)
    # 8 file_opens
    for i, f in enumerate(["a.cpp", "b.cpp", "c.cpp", "d.cpp", "e.cpp", "f.cpp", "g.cpp", "h.cpp"]):
        _inject_event(sid, 100 + i, "file_open", {"file": f})
    # 10 AI inserts, 8 followed by a typed edit within 60s
    for i in range(10):
        _inject_event(sid, 1000 + i * 100, "edit_ai_applied", {"file": "a.cpp", "chars": 80})
    for i in range(8):
        _inject_event(sid, 1000 + i * 100 + 50, "edit_typed", {"file": "a.cpp", "chars": 10})
    # 5 test runs
    for i in range(5):
        _inject_event(sid, 5000 + i, "test_run", {"profile": "default"})
    # 10 chat prompts, 9 with code terms
    for i in range(9):
        _inject_chat(sid, f"please fix this function and return the array", ts=i)
    _inject_chat(sid, "this is broken plz help", ts=99)

    out = compute_developer_confidence(sid, _mock_client())
    # base ≈ 15 + 16 + 27 + 10 = 68, bonus 0 (no debugger)
    assert out["verdict"] == "developer"
    assert 60 <= out["score"] <= 75
    assert out["signals"]["used_debugger"] is False


def test_example_b_mid_developer_who_debugs():
    sid = "ex-b"
    _seed_session(sid)
    for f in ["a.cpp", "b.cpp", "c.cpp", "d.cpp", "e.cpp"]:
        _inject_event(sid, 100, "file_open", {"file": f})
    for i in range(10):
        _inject_event(sid, 1000 + i * 100, "edit_ai_applied", {"file": "a.cpp", "chars": 80})
    for i in range(5):  # 50%
        _inject_event(sid, 1000 + i * 100 + 50, "edit_typed", {"file": "a.cpp", "chars": 10})
    for i in range(3):
        _inject_event(sid, 5000 + i, "test_run", {"profile": "default"})
    for i in range(6):
        _inject_chat(sid, "fix the return type of this function", ts=i)
    for i in range(4):
        _inject_chat(sid, "make it work please", ts=100 + i)
    _inject_event(sid, 9000, "debug_session", {"type": "lldb", "name": "Debug LRU"})

    out = compute_developer_confidence(sid, _mock_client())
    # base ≈ 15 + 10 + 18 + 10 = 53, bonus 15 → 68
    assert out["verdict"] == "developer"
    assert out["signals"]["used_debugger"] is True
    assert out["bonus_score"] == 15


def test_example_c_pm_pretending():
    sid = "ex-c"
    _seed_session(sid)
    for f in ["a.cpp", "b.cpp"]:
        _inject_event(sid, 100, "file_open", {"file": f})
    for i in range(10):
        _inject_event(sid, 1000 + i * 100, "edit_ai_applied", {"file": "a.cpp", "chars": 80})
    _inject_event(sid, 1000 + 50, "edit_typed", {"file": "a.cpp", "chars": 5})  # 1/10 = 10%
    _inject_event(sid, 5000, "test_run", {"profile": "default"})
    _inject_chat(sid, "fix this error in the function", ts=1)  # 1/5 = 20% specificity
    for i in range(4):
        _inject_chat(sid, "doesn't work make it work", ts=2 + i)

    out = compute_developer_confidence(sid, _mock_client())
    # base ≈ 6 + 2 + 6 + 3 = 17, bonus 0
    assert out["verdict"] == "non_developer"
    assert out["score"] < 35


def test_example_d_non_dev_clicking_around():
    sid = "ex-d"
    _seed_session(sid)
    for f in ["a.cpp", "b.cpp", "c.cpp", "d.cpp", "e.cpp", "f.cpp"]:
        _inject_event(sid, 100, "file_open", {"file": f})
    for i in range(5):
        _inject_event(sid, 1000 + i * 100, "edit_ai_applied", {"file": "a.cpp", "chars": 80})
    # zero post-AI edits
    for i in range(4):
        _inject_event(sid, 5000 + i, "test_run", {"profile": "default"})
    # ~15% specificity
    _inject_chat(sid, "what does this function do", ts=1)
    for i in range(6):
        _inject_chat(sid, "make it work please", ts=2 + i)

    out = compute_developer_confidence(sid, _mock_client())
    # base ≈ 15 + 0 + 4 + 10 = 29, bonus 0
    assert out["verdict"] == "non_developer"
    assert out["score"] < 35


# ── Specific signal correctness ───────────────────────────────────────────────

def test_file_open_dedupes_by_distinct_paths():
    sid = "files"
    _seed_session(sid)
    _inject_event(sid, 100, "file_open", {"file": "a.cpp"})
    _inject_event(sid, 200, "file_open", {"file": "b.cpp"})
    _inject_event(sid, 300, "file_open", {"file": "a.cpp"})  # duplicate
    out = compute_developer_confidence(sid, _mock_client())
    assert out["signals"]["files_explored"] == 2


def test_post_ai_edit_window_respects_60s():
    sid = "win"
    _seed_session(sid)
    _inject_event(sid, 1_000, "edit_ai_applied", {"file": "a.cpp", "chars": 80})
    # Typed 90 seconds later → outside the 60s window, should NOT count.
    _inject_event(sid, 1_000 + 90_000, "edit_typed", {"file": "a.cpp", "chars": 10})
    out = compute_developer_confidence(sid, _mock_client())
    assert out["signals"]["ai_output_modified_ratio"] == 0


def test_prompt_specificity_none_when_no_chat():
    sid = "no-chat"
    _seed_session(sid)
    _inject_event(sid, 100, "file_open", {"file": "a.cpp"})
    out = compute_developer_confidence(sid, _mock_client())
    assert out["signals"]["prompt_specificity"] is None


def test_goto_and_refs_signals_are_reserved_false():
    sid = "reserved"
    _seed_session(sid)
    out = compute_developer_confidence(sid, _mock_client())
    assert out["signals"]["used_goto_definition"] is False
    assert out["signals"]["used_find_references"] is False
