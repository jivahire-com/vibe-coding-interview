"""Unit tests for the three-layer rubric consumers.

Covers the deterministic rubrics as PURE CONSUMERS of Layer-2 signals:
  - verification_discipline.score(signals)
  - ai_judgment.score(signals)
  - challenge_specific.score(...) + product_sense_bonus(...)
  - trap_attribution.classify (attribution classes feed the hand_fixed signal)

Each rubric now returns {score (1-10 holistic), subpoints:[{key,checks,verdict,detail}], note}.
Tests inject telemetry into a temp SQLite DB and build signals via signals.build.
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
    signals as signals_mod,
    trap_attribution,
    verification_discipline,
)

bootstrap()

_VERDICTS = {"strong", "weak", "missing", "na"}


@pytest.fixture(autouse=True)
def _clean():
    for tbl in ("grading_errors", "grades", "jobs", "chat_exchanges", "telemetry", "sessions"):
        execute(f"DELETE FROM {tbl}")
    yield


def _seed_session(sid, submitted_at=None, typed_chars=0, ai_applied_chars=0, ai=1):
    execute(
        "INSERT INTO sessions (id, session_key, candidate_email, challenge_id, "
        "branch_name, status, submitted_at, typed_chars, ai_applied_chars, ai_assistance) "
        "VALUES (?, ?, 'c@test.com', 'python-ttl-cache', ?, 'submitted', ?, ?, ?, ?)",
        (sid, f"KEY-{sid}", f"interview/{sid}", submitted_at, typed_chars, ai_applied_chars, ai),
    )


def _inject(sid, ts, event_type, payload):
    execute("INSERT INTO telemetry (session_id, ts, event_type, payload) VALUES (?, ?, ?, ?)",
            (sid, ts, event_type, json.dumps(payload)))


def _sig(sid, ai=True, submitted_at_s=None, attribution=None, clone_dir=None):
    return signals_mod.build(sid, ai_assistance=ai, submitted_at_s=submitted_at_s,
                             attribution=attribution, clone_dir=clone_dir, client=None)


def _verdicts_valid(result):
    for sp in result["subpoints"]:
        assert sp["verdict"] in _VERDICTS, sp
        assert sp["key"] and sp["checks"]


# ─── verification_discipline ─────────────────────────────────────────────────


def test_vd_no_applies_is_na():
    # No accepted AI code and no hand edits → nothing to verify. The rubric is
    # N/A (score None, dropped from the overall total), not a passing
    # pre-submit-floor 6.0 that reads as "checked their work".
    sid = "vd-empty"
    _seed_session(sid, submitted_at=2_000)
    out = verification_discipline.score(_sig(sid, submitted_at_s=2_000))
    assert out["score"] is None
    assert all(sp["verdict"] == "na" for sp in out["subpoints"])
    _verdicts_valid(out)


def test_vd_high_signals_score_high():
    sid = "vd-good"
    _seed_session(sid, submitted_at=10_000, typed_chars=500, ai_applied_chars=600)
    _inject(sid, 1_000_000, "edit_ai_applied", {"file": "a.py", "block_id": "B1", "chars": 100})
    _inject(sid, 1_010_000, "edit_typed", {"file": "a.py", "chars": 30, "post_apply_of": "B1"})
    _inject(sid, 1_030_000, "test_run", {})
    _inject(sid, 2_000_000, "edit_ai_applied", {"file": "a.py", "block_id": "B2", "chars": 80})
    _inject(sid, 2_010_000, "edit_typed", {"file": "a.py", "chars": 40, "post_apply_of": "B2"})
    _inject(sid, 2_040_000, "test_run", {})
    _inject(sid, 10_000_000 - 60_000, "test_run", {})
    out = verification_discipline.score(_sig(sid, submitted_at_s=10_000))
    assert out["score"] >= 8.0
    assert out["note"] is None
    keys = {sp["key"] for sp in out["subpoints"]}
    assert keys == {"test_after_apply_ratio", "apply_then_edit_rate",
                    "self_authored_ratio", "incremental_apply_pattern"}


def test_vd_blind_accept_scores_low():
    sid = "vd-blind"
    _seed_session(sid, submitted_at=10_000, typed_chars=50, ai_applied_chars=5_000)
    for i, bid in enumerate(("B1", "B2", "B3")):
        _inject(sid, 1_000_000 + i * 100_000, "edit_ai_applied",
                {"file": "a.py", "block_id": bid, "chars": 1_500})
    out = verification_discipline.score(_sig(sid, submitted_at_s=10_000))
    assert out["score"] < 5.0


def test_vd_non_ai_uses_edit_cadence():
    sid = "vd-nonai"
    _seed_session(sid, submitted_at=10_000, typed_chars=2_000, ai=0)
    _inject(sid, 1_000_000, "edit_typed", {"file": "a.py", "chars": 120})
    _inject(sid, 1_030_000, "test_run", {})
    _inject(sid, 10_000_000 - 30_000, "test_run", {})
    out = verification_discipline.score(_sig(sid, ai=False, submitted_at_s=10_000))
    keys = {sp["key"] for sp in out["subpoints"]}
    assert keys == {"test_after_edit_ratio", "self_authored_ratio", "incremental_pattern"}
    assert out["note"] is None  # pre-submit test present


# ─── ai_judgment ─────────────────────────────────────────────────────────────


def test_aj_rejections_drive_score_up():
    sid = "aj-rej"
    _seed_session(sid, typed_chars=500, ai_applied_chars=500)
    for i in range(3):
        _inject(sid, 1_000_000 + i, "edit_ai_rejected", {"block_id": f"R{i}"})
    out = ai_judgment.score(_sig(sid))
    rej = next(sp for sp in out["subpoints"] if sp["key"] == "explicit_rejections")
    assert rej["verdict"] == "strong"


def test_aj_zero_rejections_missing():
    sid = "aj-norej"
    _seed_session(sid, typed_chars=500, ai_applied_chars=500)
    _inject(sid, 1_000_000, "edit_ai_applied", {"file": "a.py", "block_id": "B1", "chars": 100})
    out = ai_judgment.score(_sig(sid))
    rej = next(sp for sp in out["subpoints"] if sp["key"] == "explicit_rejections")
    assert rej["verdict"] == "missing"


def test_aj_no_interaction_is_na():
    # Opened the session and did nothing: no AI accepts, no rejections, no chat,
    # no traps, no git history. There is nothing to judge — every sub-signal is
    # N/A and the rubric drops out rather than showing STRONG on absence.
    sid = "aj-noop"
    _seed_session(sid)
    out = ai_judgment.score(_sig(sid))
    assert out["score"] is None
    assert all(sp["verdict"] == "na" for sp in out["subpoints"])
    _verdicts_valid(out)


def test_aj_hand_fixed_trap_is_strong():
    sid = "aj-hand"
    _seed_session(sid, typed_chars=2_000, ai_applied_chars=200)
    attribution = {"attributions": {
        "race": {"class": "hand-fixed"}, "off_by_one": {"class": "ai-fixed-reviewed"}}}
    out = ai_judgment.score(_sig(sid, attribution=attribution))
    hand = next(sp for sp in out["subpoints"] if sp["key"] == "hand_fixed_traps")
    assert hand["verdict"] == "strong"


# ─── trap_attribution (unchanged contract) ───────────────────────────────────


def test_attribution_hand_fixed_when_no_applies():
    sid = "att-hand"
    _seed_session(sid, typed_chars=1_000, ai_applied_chars=0)
    out = trap_attribution.classify(sid, [{"id": "race", "description": "..."}])
    assert out["attributions"]["race"]["class"] == "hand-fixed"


def test_attribution_no_traps_returns_empty():
    sid = "att-empty"
    _seed_session(sid)
    out = trap_attribution.classify(sid, [])
    assert out["attributions"] == {}


# ─── challenge_specific ──────────────────────────────────────────────────────


def test_challenge_specific_unknown_returns_default():
    with tempfile.TemporaryDirectory() as td:
        out = challenge_specific.score("some-unknown-challenge", Path(td), {})
        assert out["score"] == challenge_specific.DEFAULT_SCORE
        assert out["subpoints"] == []
        assert "no per-challenge criteria" in out["note"].lower()


def test_challenge_specific_python_correct_choices():
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "src"
        src.mkdir()
        (src / "ttl_cache.py").write_text(
            "import threading, time\n"
            "class Cache:\n"
            "    def __init__(self):\n"
            "        self._lock = threading.Lock()\n"
            "        self._data = {}\n"
            "    def get(self, k, ttl=60):\n"
            "        with self._lock:\n"
            "            v, t = self._data.get(k, (None, 0))\n"
            "            if time.monotonic() - t > ttl:\n"
            "                return None\n"
            "            return v\n"
        )
        out = challenge_specific.score("python-ttl-cache", Path(td),
                                       {"submission_files": ["src/ttl_cache.py"]})
        assert out["score"] >= 8.5
        verdicts = {sp["key"]: sp["verdict"] for sp in out["subpoints"]}
        assert verdicts["sync_primitive"] == "strong"
        assert verdicts["time_source"] == "strong"
        _verdicts_valid(out)


def test_challenge_specific_cpp_shared_lock_is_the_trap():
    with tempfile.TemporaryDirectory() as td:
        inc = Path(td) / "include"
        inc.mkdir()
        (inc / "lru_cache.hpp").write_text(
            "#include <shared_mutex>\n"
            "template <typename K, typename V> class LRUCache {\n"
            "  std::optional<V> get(const K& k){ std::shared_lock<std::shared_mutex> g(m_); }\n"
            "  std::shared_mutex m_;\n};\n"
        )
        out = challenge_specific.score("cpp-thread-safe-cache", Path(td),
                                       {"submission_files": ["include/lru_cache.hpp"]})
        sync = next(sp for sp in out["subpoints"] if sp["key"] == "sync_primitive")
        assert sync["verdict"] in ("missing", "weak")


# ─── product-sense bonus ─────────────────────────────────────────────────────


def test_product_sense_not_attempted_is_neutral():
    with tempfile.TemporaryDirectory() as td:
        (Path(td) / "include").mkdir()
        (Path(td) / "include" / "lru_cache.hpp").write_text("template<class K,class V> class C{};\n")
        out = challenge_specific.product_sense_bonus(
            Path(td), {"submission_files": ["include/lru_cache.hpp"]}, design_why=None)
        assert out["boost"] == 0.0
        assert out["card"]["attempted"] is False
        assert out["card"]["subpoints"] == []


def test_product_sense_attempted_lifts_and_has_subpoints():
    with tempfile.TemporaryDirectory() as td:
        inc = Path(td) / "include"
        inc.mkdir()
        (inc / "lru_cache.hpp").write_text(
            "#include <atomic>\nstruct Stats { std::atomic<long> hit_count{0}; };\n")
        (Path(td) / "NOTES.md").write_text("W" * 250 + " because the on-call need is real; added a test.")
        out = challenge_specific.product_sense_bonus(
            Path(td), {"submission_files": ["include/lru_cache.hpp"]},
            design_why="Chose atomics because the counter is hot.")
        assert out["boost"] > 0.0
        assert out["card"]["attempted"] is True
        assert out["card"]["lifts"] == "architectural reasoning"
        keys = {sp["key"] for sp in out["card"]["subpoints"]}
        assert keys == {"real_need", "justified_choice", "thread_safe", "proven_by_tests"}
