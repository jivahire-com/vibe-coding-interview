"""Tests for Layer-2 signals (grader/signals.py).

Signals are the single derivation surface: every value computed once from
telemetry, read by the Layer-3 rubrics. These tests verify the direct
derivations and the track-aware behaviour (apply-keyed facts on vibe, edit
cadence on non-AI) without any LLM call.
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
from vibe.grader import signals as S  # noqa: E402

bootstrap()


@pytest.fixture(autouse=True)
def _clean():
    for tbl in ("grading_errors", "grades", "jobs", "chat_exchanges", "telemetry", "sessions"):
        execute(f"DELETE FROM {tbl}")
    yield


def _seed(sid, ai=1, typed=0, pasted=0, ai_applied=0):
    execute(
        "INSERT INTO sessions (id, session_key, candidate_email, challenge_id, branch_name, "
        "status, ai_assistance, typed_chars, pasted_chars, ai_applied_chars) "
        "VALUES (?, ?, 'c@t.com', 'cpp-thread-safe-cache', ?, 'active', ?, ?, ?, ?)",
        (sid, f"K-{sid}", f"b/{sid}", ai, typed, pasted, ai_applied),
    )


def _inj(sid, ts, et, pl):
    execute("INSERT INTO telemetry (session_id, ts, event_type, payload) VALUES (?, ?, ?, ?)",
            (sid, ts, et, json.dumps(pl)))


def _chat(sid, ts, text):
    execute("INSERT INTO chat_exchanges (session_id, ts, model, prompt_tokens, completion_tokens, "
            "cost_usd, prompt_text) VALUES (?, ?, 'm', 100, 50, 0.0, ?)", (sid, ts, text))


def test_direct_signals_counts_and_ratios():
    sid = "s1"
    _seed(sid, typed=120, pasted=80, ai_applied=0)
    _inj(sid, 1000, "edit_pasted", {"chars": 80, "suspicious_paste": True})
    _inj(sid, 2000, "app_unfocused", {})
    _inj(sid, 3000, "app_unfocused", {})
    _inj(sid, 4000, "file_open", {"file": "a.cpp"})
    _inj(sid, 4500, "file_open", {"file": "a.cpp"})  # dedup
    _inj(sid, 5000, "test_run", {})
    _inj(sid, 6000, "terminal_command", {"kind": "build"})
    _inj(sid, 6500, "terminal_command", {"kind": "install"})
    _inj(sid, 7000, "debug_session", {})
    sig = S.build(sid, ai_assistance=True, client=None)

    assert sig.typed_chars == 120
    assert sig.pasted_chars == 80
    assert sig.suspicious_pastes == 1
    assert sig.window_switches == 2
    assert sig.files_explored == 1
    assert sig.test_runs == 1
    assert sig.build_runs == 1
    assert sig.install_runs == 1
    assert sig.used_debugger is True
    assert sig.paste_pct == pytest.approx(40.0, abs=0.1)


def test_self_authored_and_prompt_specificity():
    sid = "s2"
    _seed(sid, typed=600, ai_applied=400)
    _chat(sid, 1, "fix the function return type on line 12")  # code terms
    _chat(sid, 2, "make it nicer")  # vague
    sig = S.build(sid, ai_assistance=True, client=None)
    assert sig.self_authored_ratio == pytest.approx(0.6, abs=0.001)
    assert sig.prompt_specificity == 0.5
    assert sig.num_chat_exchanges == 2
    assert sig.total_chat_tokens == 300


def test_apply_keyed_facts_on_vibe():
    sid = "s3"
    _seed(sid, typed=100, ai_applied=200)
    _inj(sid, 1000, "edit_ai_applied", {"file": "a.cpp", "block_id": "B1", "chars": 100})
    _inj(sid, 1500, "edit_typed", {"file": "a.cpp", "chars": 40, "post_apply_of": "B1"})
    _inj(sid, 1800, "test_run", {})
    sig = S.build(sid, ai_assistance=True, client=None)
    assert sig.test_after_apply["ratio"] == 1.0
    assert sig.apply_then_edit["rate"] == 1.0
    assert sig.modify_after_apply["rate"] == 1.0


def test_edit_cadence_fallback_on_non_ai():
    sid = "s4"
    _seed(sid, ai=0, typed=300)
    _inj(sid, 1000, "edit_typed", {"file": "a.py", "chars": 120})
    _inj(sid, 1500, "edit_typed", {"file": "a.py", "chars": 80})
    _inj(sid, 1600, "test_run", {})  # within 90s of the burst end
    sig = S.build(sid, ai_assistance=False, client=None)
    assert sig.test_after_edit["bursts"] == 1
    assert sig.test_after_edit["ratio"] == 1.0
    assert sig.incremental_edit["mean_chars"] == 200.0
    # apply-keyed facts are empty (no applies) — None ratios
    assert sig.test_after_apply["ratio"] is None


def test_hand_fixed_traps_from_attribution():
    sid = "s5"
    _seed(sid)
    attribution = {"attributions": {
        "race": {"class": "hand-fixed"}, "ob1": {"class": "ai-fixed-blind"}}}
    sig = S.build(sid, ai_assistance=True, attribution=attribution, client=None)
    assert sig.hand_fixed_traps["hand_fixed"] == 1
    assert sig.hand_fixed_traps["total"] == 2


def test_llm_signals_none_without_client():
    sid = "s6"
    _seed(sid)
    sig = S.build(sid, ai_assistance=True, client=None)
    assert sig.prompt_classification is None
    assert sig.design_why is None
