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


# ─── grader_summary builder ──────────────────────────────────────────────────

import re  # noqa: E402

_SUMMARY_LINE_RE = re.compile(r"^(.+?)\s*\(([\d.]+/10)\)\s*:\s*(.+)$")


def _split_summary(summary: str) -> list[str]:
    return summary.split(" | ")


def _sample_llm_dims():
    """Realistic llm_dims with per-criterion breakdowns."""
    return {
        "code_quality": {
            "score": 8.35,
            "breakdown": {
                "criteria": {
                    "correctness": {"score": 9, "reasoning": "all hidden tests passed"},
                    "no_ai_defects": {"score": 6, "reasoning": "introduced extra abstraction layer not needed by problem"},
                    "clarity": {"score": 9, "reasoning": "well-named identifiers"},
                },
            },
        },
        "llm_communication": {
            "score": 2.3,
            "breakdown": {
                "criteria": {
                    "context_framing": {"score": 2, "reasoning": "prompt #1 dumps whole file, no question asked"},
                    "constraint_spec": {"score": 4, "reasoning": "did not state O(1) requirement"},
                },
            },
        },
        "architectural_reasoning": {
            "score": 5.35,
            "breakdown": {
                "criteria": {
                    "concurrency_design": {"score": 7, "reasoning": "single coarse lock covers full critical section"},
                    "edge_case_awareness": {"score": 3, "reasoning": "capacity=0 not handled"},
                },
            },
        },
    }


def _sample_vd():
    return {
        "score": 6.4,
        "breakdown": {
            "signals": {
                "test_after_apply_ratio": {"score": 7.0, "ratio": 0.6, "applies": 5},
                "self_authored_ratio":    {"score": 3.0, "ratio": 0.2, "reason": "ratio 0.20 below healthy band"},
            },
        },
    }


def _sample_aj():
    return {
        "score": 4.2,
        "breakdown": {
            "signals": {
                "explicit_rejections": {"score": 2.0, "count": 0},
                "modify_after_apply":  {"score": 5.0, "rate": 0.4},
            },
        },
    }


def _sample_cs_with_criteria():
    return {
        "score": 6.0,
        "breakdown": {
            "criteria": {
                "sync_primitive": {"score": 9.0, "reason": "uses threading.Lock — correct default"},
                "time_source":    {"score": 3.0, "reason": "uses time.time — vulnerable to wall-clock jumps"},
            },
        },
    }


def test_summary_covers_all_eight_dimensions_in_rubric_order():
    dim_scores = {
        "tests": 8.0, "traps": 6.0, "verification_discipline": 6.4, "ai_judgment": 4.2,
        "llm_communication": 2.3, "code_quality": 8.35, "architectural_reasoning": 5.35,
        "challenge_specific": 6.0,
    }
    summary = runner._build_summary(
        dim_scores, tests_passed=4, tests_total=5, traps_detected=3, traps_total=5,
        llm_dims=_sample_llm_dims(), vd=_sample_vd(), aj=_sample_aj(),
        cs=_sample_cs_with_criteria(),
    )
    lines = _split_summary(summary)
    # Eight rubric dimensions → eight summary lines.
    assert len(lines) == 8
    labels = [_SUMMARY_LINE_RE.match(line).group(1) for line in lines]
    assert labels == [
        "Tests", "Traps", "Verification discipline", "AI judgment",
        "LLM communication", "Code quality", "Architectural reasoning",
        "Challenge-specific",
    ]


def test_summary_lines_match_ui_parser_regex():
    """parseSummaryLine in app.js matches `^(.+?)\\s*\\(([\\d.]+/10)\\):\\s*(.+)$`."""
    dim_scores = {k: 5.0 for k in runner.COMPOSITE_WEIGHTS}
    summary = runner._build_summary(
        dim_scores, tests_passed=0, tests_total=0, traps_detected=0, traps_total=0,
        llm_dims=_sample_llm_dims(), vd=_sample_vd(), aj=_sample_aj(),
        cs=_sample_cs_with_criteria(),
    )
    for line in _split_summary(summary):
        m = _SUMMARY_LINE_RE.match(line)
        assert m is not None, f"line not parseable by UI regex: {line!r}"
        # body (reasoning) must be present and non-empty
        assert m.group(3).strip()


def test_summary_surfaces_weakest_criterion_reasoning():
    """For LLM dims, the line should cite the lowest-scoring criterion."""
    dim_scores = {k: 5.0 for k in runner.COMPOSITE_WEIGHTS}
    summary = runner._build_summary(
        dim_scores, tests_passed=4, tests_total=5, traps_detected=2, traps_total=4,
        llm_dims=_sample_llm_dims(), vd=_sample_vd(), aj=_sample_aj(),
        cs=_sample_cs_with_criteria(),
    )
    # Code quality: weakest is no_ai_defects @ 6
    cq_line = next(l for l in _split_summary(summary) if l.startswith("Code quality"))
    assert "no_ai_defects" in cq_line
    assert "extra abstraction" in cq_line
    # LLM communication: weakest is context_framing @ 2
    lc_line = next(l for l in _split_summary(summary) if l.startswith("LLM communication"))
    assert "context_framing" in lc_line
    # Architectural: weakest is edge_case_awareness @ 3
    ar_line = next(l for l in _split_summary(summary) if l.startswith("Architectural reasoning"))
    assert "edge_case_awareness" in ar_line


def test_summary_tests_and_traps_use_x_of_y():
    summary = runner._build_summary(
        {k: 5.0 for k in runner.COMPOSITE_WEIGHTS},
        tests_passed=4, tests_total=5, traps_detected=2, traps_total=3,
        llm_dims=_sample_llm_dims(), vd=_sample_vd(), aj=_sample_aj(),
        cs=_sample_cs_with_criteria(),
    )
    assert "Tests (5/10): 4 of 5 hidden test tags passed" in summary
    assert "Traps (5/10): 2 of 3 planted traps caught" in summary


def test_summary_sanitises_separator_in_reasoning():
    """Reasoning that contains ' | ' must be rewritten so UI split doesn't shatter it."""
    llm_dims = _sample_llm_dims()
    llm_dims["code_quality"]["breakdown"]["criteria"]["no_ai_defects"]["reasoning"] = \
        "race in lock | hallucinated mutex_guard API | uses raw new/delete"
    summary = runner._build_summary(
        {k: 5.0 for k in runner.COMPOSITE_WEIGHTS},
        tests_passed=0, tests_total=0, traps_detected=0, traps_total=0,
        llm_dims=llm_dims, vd=_sample_vd(), aj=_sample_aj(),
        cs=_sample_cs_with_criteria(),
    )
    # Still exactly 8 lines after split — the sanitiser replaces ' | ' with ' / '.
    assert len(_split_summary(summary)) == 8


# ─── _classify_prompts_and_persist ───────────────────────────────────────────


class _StubChoice:
    def __init__(self, content):
        self.message = type("M", (), {"content": content})


class _StubResp:
    def __init__(self, content):
        self.choices = [_StubChoice(content)]


class _StubChatCompletions:
    def __init__(self, content):
        self._content = content
        self.calls = 0

    def create(self, **kwargs):
        self.calls += 1
        return _StubResp(self._content)


class _StubClient:
    def __init__(self, content):
        self.chat = type("C", (), {"completions": _StubChatCompletions(content)})()


def _seed_chat_exchange(sid: str, ts: int, prompt_text: str) -> int:
    execute(
        "INSERT INTO chat_exchanges (session_id, ts, model, prompt_tokens, "
        "completion_tokens, cost_usd, prompt_text) "
        "VALUES (?, ?, 'm', 0, 0, 0.0, ?)",
        (sid, ts, prompt_text),
    )
    from vibe.db import query as _query
    rows = _query("SELECT id FROM chat_exchanges WHERE session_id=? ORDER BY ts", (sid,))
    return rows[-1]["id"]


def test_classify_prompts_persists_three_recruiter_fields():
    from vibe.db import query as _query
    from vibe.grader import llm_eval as _llm_eval

    sid = "cp-good"
    _seed_session(sid)
    _seed_chat_exchange(sid, 1_000, "fix this")
    _seed_chat_exchange(sid, 2_000, "test_lru.cpp:42 asserts evict order — what invariant am I breaking?")

    payload = json.dumps({"classifications": [
        {"index": 1, "classification": "vague", "level": 1, "score": 2,
         "reasoning": "generic 'fix this' with no context"},
        {"index": 2, "classification": "professional", "level": 4, "score": 9,
         "reasoning": "cites failing assertion + line number"},
    ]})
    client = _StubClient(payload)
    chat_log = [
        {"prompt_text": "fix this"},
        {"prompt_text": "test_lru.cpp:42 asserts evict order — what invariant am I breaking?"},
    ]
    _llm_eval._classify_prompts_and_persist(client, chat_log, {"5": "x", "1": "y"}, sid)

    rows = _query(
        "SELECT prompt_text, prompt_classification, prompt_score, prompt_reasoning, prompt_level "
        "FROM chat_exchanges WHERE session_id=? ORDER BY ts", (sid,)
    )
    assert rows[0]["prompt_classification"] == "vague"
    assert rows[0]["prompt_score"] == 2
    assert "generic" in rows[0]["prompt_reasoning"]
    assert rows[0]["prompt_level"] == 1
    assert rows[1]["prompt_classification"] == "professional"
    assert rows[1]["prompt_score"] == 9
    assert rows[1]["prompt_level"] == 4


def test_classify_prompts_clamps_score_and_falls_back_classification():
    from vibe.db import query as _query
    from vibe.grader import llm_eval as _llm_eval

    sid = "cp-clamp"
    _seed_session(sid)
    _seed_chat_exchange(sid, 1_000, "p1")

    # No classification provided, level=4 → should derive "professional";
    # score=15 → clamped to 10.
    payload = json.dumps({"classifications": [
        {"index": 1, "level": 4, "score": 15, "reasoning": "ok"},
    ]})
    client = _StubClient(payload)
    _llm_eval._classify_prompts_and_persist(
        client, [{"prompt_text": "p1"}], {"4": "Professional"}, sid,
    )
    row = _query(
        "SELECT prompt_classification, prompt_score FROM chat_exchanges "
        "WHERE session_id=?", (sid,),
    )[0]
    assert row["prompt_classification"] == "professional"
    assert row["prompt_score"] == 10


def test_classify_prompts_swallows_llm_failure():
    """LLM exception must not block grading — function returns silently."""
    from vibe.grader import llm_eval as _llm_eval

    class _Boom:
        class chat:
            class completions:
                @staticmethod
                def create(**kw):
                    raise RuntimeError("openrouter down")

    sid = "cp-boom"
    _seed_session(sid)
    _seed_chat_exchange(sid, 1_000, "p1")
    _llm_eval._classify_prompts_and_persist(
        _Boom(), [{"prompt_text": "p1"}], {"5": "x"}, sid,
    )  # must not raise
