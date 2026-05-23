"""Unit tests for the rubric-aligned grader dimensions.

Covers:
  - verification_discipline.compute (test_after_apply, apply_then_edit,
    self_authored_ratio, incremental, pre_submit floor)
  - trap_attribution.classify (3 attribution classes)
  - ai_judgment.compute (rejections, modify_after_apply, hand_fixed bonus)
  - challenge_specific.compute (per-challenge dispatch + defaults)
  - runner._composite (weights sum to 1.0; weighted-sum sanity)

The tests inject telemetry/chat directly into a temp SQLite DB so we don't
need a real session lifecycle, clone, or LLM call.
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
from vibe.grader import (  # noqa: E402
    ai_judgment,
    challenge_specific,
    runner,
    trap_attribution,
    verification_discipline,
)

bootstrap()


@pytest.fixture(autouse=True)
def _clean():
    for tbl in ("grading_errors", "grades", "jobs", "chat_exchanges", "telemetry", "sessions"):
        execute(f"DELETE FROM {tbl}")
    yield


# ─── Fixtures ─────────────────────────────────────────────────────────────────


def _seed_session(sid: str, submitted_at: int | None = None,
                  typed_chars: int = 0, ai_applied_chars: int = 0) -> None:
    execute(
        "INSERT INTO sessions (id, session_key, candidate_email, challenge_id, "
        " branch_name, status, submitted_at, typed_chars, ai_applied_chars) "
        "VALUES (?, ?, 'c@test.com', 'python-ttl-cache', ?, 'submitted', ?, ?, ?)",
        (sid, f"KEY-{sid}", f"interview/{sid}", submitted_at, typed_chars, ai_applied_chars),
    )


def _inject(sid: str, ts: int, event_type: str, payload: dict) -> None:
    execute(
        "INSERT INTO telemetry (session_id, ts, event_type, payload) VALUES (?, ?, ?, ?)",
        (sid, ts, event_type, json.dumps(payload)),
    )


# ─── verification_discipline ─────────────────────────────────────────────────


def test_vd_no_applies_returns_neutral_with_floor_applied():
    sid = "vd-empty"
    _seed_session(sid, submitted_at=2_000)
    out = verification_discipline.compute(sid, submitted_at_s=2_000)
    assert out["score"] <= 6.0  # pre_submit floor caps because no test_run
    assert out["breakdown"]["pre_submit_floor_applied"] is True


def test_vd_high_test_after_apply_and_review_scores_high():
    sid = "vd-good"
    _seed_session(sid, submitted_at=10_000, typed_chars=500, ai_applied_chars=600)
    # 2 applies with test_runs 30s later and post_apply_of follow-ups
    _inject(sid, 1_000_000, "edit_ai_applied", {"file": "a.py", "block_id": "B1", "chars": 100})
    _inject(sid, 1_010_000, "edit_typed", {"file": "a.py", "chars": 30, "post_apply_of": "B1"})
    _inject(sid, 1_030_000, "test_run", {"profile": "default"})
    _inject(sid, 2_000_000, "edit_ai_applied", {"file": "a.py", "block_id": "B2", "chars": 80})
    _inject(sid, 2_010_000, "edit_typed", {"file": "a.py", "chars": 40, "post_apply_of": "B2"})
    _inject(sid, 2_040_000, "test_run", {"profile": "default"})
    # Pre-submit test_run (5 min = 300s before submitted_at*1000)
    _inject(sid, 10_000_000 - 60_000, "test_run", {"profile": "default"})

    out = verification_discipline.compute(sid, submitted_at_s=10_000)
    sigs = out["breakdown"]["signals"]
    assert sigs["test_after_apply_ratio"]["ratio"] == 1.0
    assert sigs["apply_then_edit_rate"]["rate"] == 1.0
    assert sigs["pre_submit_test_run"]["passed"] is True
    assert out["score"] >= 8.0


def test_vd_blind_accept_pattern_scores_low():
    sid = "vd-blind"
    _seed_session(sid, submitted_at=10_000, typed_chars=50, ai_applied_chars=5_000)
    # 3 large applies with no test_runs and no follow-up edits.
    for i, bid in enumerate(("B1", "B2", "B3")):
        _inject(sid, 1_000_000 + i * 100_000, "edit_ai_applied",
                {"file": "a.py", "block_id": bid, "chars": 1_500})
    out = verification_discipline.compute(sid, submitted_at_s=10_000)
    sigs = out["breakdown"]["signals"]
    assert sigs["test_after_apply_ratio"]["ratio"] == 0.0
    assert sigs["apply_then_edit_rate"]["rate"] == 0.0
    assert sigs["self_authored_ratio"]["score"] <= 5.0  # self_ratio ~0.01
    assert out["score"] < 5.0


def test_vd_pre_submit_floor_caps_at_6():
    sid = "vd-no-presub"
    _seed_session(sid, submitted_at=10_000, typed_chars=300, ai_applied_chars=200)
    # Strong signals everywhere EXCEPT pre-submit test_run.
    _inject(sid, 1_000_000, "edit_ai_applied", {"file": "a.py", "block_id": "B1", "chars": 100})
    _inject(sid, 1_010_000, "edit_typed", {"file": "a.py", "chars": 30, "post_apply_of": "B1"})
    _inject(sid, 1_030_000, "test_run", {"profile": "default"})
    out = verification_discipline.compute(sid, submitted_at_s=10_000)
    assert out["breakdown"]["pre_submit_floor_applied"] is True
    assert out["score"] <= 6.0


# ─── trap_attribution ────────────────────────────────────────────────────────


def test_attribution_hand_fixed_when_no_applies():
    sid = "att-hand"
    _seed_session(sid, typed_chars=1_000, ai_applied_chars=0)
    out = trap_attribution.classify(sid, [{"id": "race", "description": "..."}])
    assert out["attributions"]["race"]["class"] == "hand-fixed"


def test_attribution_ai_reviewed_when_post_apply_edits_present():
    sid = "att-reviewed"
    _seed_session(sid, typed_chars=500, ai_applied_chars=500)
    _inject(sid, 1_000_000, "edit_ai_applied", {"file": "a.py", "block_id": "B1", "chars": 200})
    _inject(sid, 1_010_000, "edit_typed", {"file": "a.py", "chars": 80, "post_apply_of": "B1"})
    out = trap_attribution.classify(sid, [{"id": "race", "description": "..."}])
    assert out["attributions"]["race"]["class"] == "ai-fixed-reviewed"


def test_attribution_ai_blind_when_no_followup_edits():
    sid = "att-blind"
    _seed_session(sid, typed_chars=10, ai_applied_chars=2_000)
    _inject(sid, 1_000_000, "edit_ai_applied", {"file": "a.py", "block_id": "B1", "chars": 2_000})
    out = trap_attribution.classify(sid, [{"id": "race", "description": "..."}])
    assert out["attributions"]["race"]["class"] == "ai-fixed-blind"


def test_attribution_no_traps_returns_empty():
    sid = "att-empty"
    _seed_session(sid)
    out = trap_attribution.classify(sid, [])
    assert out["attributions"] == {}


# ─── ai_judgment ─────────────────────────────────────────────────────────────


def test_aj_explicit_rejections_drive_score_up():
    sid = "aj-rej"
    _seed_session(sid, typed_chars=500, ai_applied_chars=500)
    for i in range(3):
        _inject(sid, 1_000_000 + i * 1_000, "edit_ai_rejected",
                {"file": "a.py", "block_id": f"R{i}", "chars": 80})
    out = ai_judgment.compute(sid, clone_dir=None, attribution=None)
    assert out["breakdown"]["signals"]["explicit_rejections"]["count"] == 3
    assert out["breakdown"]["signals"]["explicit_rejections"]["score"] == 9.0


def test_aj_zero_rejections_penalised():
    sid = "aj-norej"
    _seed_session(sid, typed_chars=500, ai_applied_chars=500)
    _inject(sid, 1_000_000, "edit_ai_applied", {"file": "a.py", "block_id": "B1", "chars": 100})
    out = ai_judgment.compute(sid, clone_dir=None, attribution=None)
    assert out["breakdown"]["signals"]["explicit_rejections"]["count"] == 0
    assert out["breakdown"]["signals"]["explicit_rejections"]["score"] == 2.0


def test_aj_hand_fixed_traps_bonus():
    sid = "aj-handfixed"
    _seed_session(sid, typed_chars=2_000, ai_applied_chars=200)
    _inject(sid, 1_000_000, "edit_ai_applied", {"file": "a.py", "block_id": "B1", "chars": 200})
    attribution = {
        "attributions": {
            "race": {"class": "hand-fixed", "reason": "..."},
            "off_by_one": {"class": "ai-fixed-reviewed", "reason": "..."},
        }
    }
    out = ai_judgment.compute(sid, clone_dir=None, attribution=attribution)
    assert out["breakdown"]["signals"]["hand_fixed_traps"]["score"] == 9.0
    assert out["breakdown"]["signals"]["hand_fixed_traps"]["hand_fixed"] == 1


# ─── challenge_specific ──────────────────────────────────────────────────────


def test_challenge_specific_unknown_returns_default():
    with tempfile.TemporaryDirectory() as td:
        out = challenge_specific.compute("some-unknown-challenge", Path(td), {})
        assert out["score"] == challenge_specific.DEFAULT_SCORE
        assert "no per-challenge criteria" in out["breakdown"]["reason"]


def test_challenge_specific_python_ttl_cache_correct_choices():
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "src"
        src.mkdir()
        (src / "ttl_cache.py").write_text("""
import threading, time
class Cache:
    def __init__(self):
        self._lock = threading.Lock()
        self._data = {}
    def put(self, k, v, ttl=60):
        with self._lock:
            self._data[k] = (v, time.monotonic())
    def get(self, k, ttl=60):
        with self._lock:
            v, t = self._data.get(k, (None, 0))
            if time.monotonic() - t > ttl:
                return None
            return v
""")
        out = challenge_specific.compute(
            "python-ttl-cache", Path(td),
            {"submission_files": ["src/ttl_cache.py"]},
        )
        crit = out["breakdown"]["criteria"]
        assert crit["sync_primitive"]["score"] == 9.0
        assert crit["time_source"]["score"] == 9.0
        assert crit["ttl_strategy"]["score"] == 9.0
        assert out["score"] == 9.0


def test_challenge_specific_python_ttl_cache_wrong_choices():
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "src"
        src.mkdir()
        (src / "ttl_cache.py").write_text("""
import threading, time
class Cache:
    def __init__(self):
        self._lock = threading.RLock()  # overkill
        self._data = {}
    def put(self, k, v):
        with self._lock:
            self._data[k] = (v, time.time())  # wall clock
    def get(self, k):
        return self._data.get(k, (None, 0))[0]  # no TTL check
""")
        out = challenge_specific.compute(
            "python-ttl-cache", Path(td),
            {"submission_files": ["src/ttl_cache.py"]},
        )
        crit = out["breakdown"]["criteria"]
        assert crit["sync_primitive"]["score"] < 9.0
        assert crit["time_source"]["score"] < 9.0
        assert crit["ttl_strategy"]["score"] < 9.0


# ─── Composite (runner) ──────────────────────────────────────────────────────


def test_composite_weights_sum_to_one():
    assert abs(sum(runner.COMPOSITE_WEIGHTS.values()) - 1.0) < 1e-9


def test_composite_all_tens_equals_ten():
    dim_scores = {k: 10.0 for k in runner.COMPOSITE_WEIGHTS}
    total, _ = runner._composite(dim_scores)
    assert round(total, 4) == 10.0


def test_composite_weighted_sum_matches_breakdown():
    dim_scores = {
        "tests": 8.0,                     # 0.20 → 1.60
        "traps": 6.0,                     # 0.12 → 0.72
        "verification_discipline": 7.0,   # 0.13 → 0.91
        "ai_judgment": 5.0,               # 0.08 → 0.40
        "llm_communication": 9.0,         # 0.17 → 1.53
        "code_quality": 8.0,              # 0.15 → 1.20
        "architectural_reasoning": 7.0,   # 0.10 → 0.70
        "challenge_specific": 6.0,        # 0.05 → 0.30
    }
    total, breakdown = runner._composite(dim_scores)
    assert round(total, 2) == 7.36
    assert set(breakdown["dimensions"].keys()) == set(dim_scores.keys())
    assert breakdown["dimensions"]["tests"]["weighted_contribution"] == 1.6
