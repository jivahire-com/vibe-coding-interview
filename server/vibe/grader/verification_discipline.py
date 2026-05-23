"""
Verification Discipline (13% of composite, telemetry-derived, ungameable).

Scores how thoroughly the candidate verified AI-generated code before moving on.
Pure-deterministic — no LLM call. Signals come straight from the per-session
telemetry stream populated by the VS Code extension.

Sub-signals per the rubric (GRADING_RUBRICS.md, "Verification Discipline"):

  - test_after_apply_ratio:  applies followed by a test_run within 90s
  - apply_then_edit_rate:    applies with a follow-up edit carrying
                              post_apply_of=<block_id> before the next commit
  - self_authored_ratio:     typed_chars / (typed_chars + ai_applied_chars),
                              healthy band 0.40–0.70
  - incremental_apply_pattern: smaller applies and at least one test between
                              consecutive applies score higher
  - pre_submit_test_run:     boolean floor — at least one test_run in the
                              5 min before submission caps the score at 6 if
                              missing.
"""

from __future__ import annotations

import json
import statistics
from typing import Any

from vibe.db import query

# Window (ms) inside which a follow-up test_run "covers" an AI apply.
_TEST_AFTER_APPLY_WINDOW_MS = 90_000
# Window (ms) before submitted_at in which a test_run satisfies the floor.
_PRE_SUBMIT_TEST_WINDOW_MS = 5 * 60_000

# Weights for the sub-scores → composite (sum to 1.0).
_WEIGHTS = {
    "test_after_apply_ratio": 0.40,
    "apply_then_edit_rate": 0.25,
    "self_authored_ratio": 0.20,
    "incremental_apply_pattern": 0.15,
}

# Hard cap when pre_submit_test_run is missing (rubric: "Required floor for any
# score >= 7").
_PRE_SUBMIT_FLOOR_CAP = 6.0


def compute(session_id: str, submitted_at_s: int | None) -> dict[str, Any]:
    """Return {score: float 1-10, breakdown: {...}} for this session.

    `submitted_at_s` is in **seconds** (matches the sessions.submitted_at column
    populated by submit.py). Telemetry events use millisecond timestamps; the
    pre-submit floor check converts internally.
    """
    events = _load_events(session_id)
    counters = _load_counters(session_id)
    submitted_at_ms = (submitted_at_s * 1000) if submitted_at_s is not None else None

    signals: dict[str, dict[str, Any]] = {
        "test_after_apply_ratio": _score_test_after_apply(events),
        "apply_then_edit_rate": _score_apply_then_edit(events),
        "self_authored_ratio": _score_self_authored(counters),
        "incremental_apply_pattern": _score_incremental(events),
        "pre_submit_test_run": _score_pre_submit(events, submitted_at_ms),
    }

    raw = sum(signals[k]["score"] * w for k, w in _WEIGHTS.items())
    floor_applied = not signals["pre_submit_test_run"]["passed"]
    final = min(raw, _PRE_SUBMIT_FLOOR_CAP) if floor_applied else raw

    return {
        "score": round(float(final), 2),
        "breakdown": {
            "signals": signals,
            "weights": _WEIGHTS,
            "raw_weighted": round(float(raw), 2),
            "pre_submit_floor_applied": floor_applied,
            "pre_submit_floor_cap": _PRE_SUBMIT_FLOOR_CAP,
        },
    }


# ─── Loaders ──────────────────────────────────────────────────────────────────


def _load_events(session_id: str) -> list[dict[str, Any]]:
    """Pull all telemetry events for the session, oldest first.

    payload is parsed into a dict here so downstream code doesn't have to
    handle JSON strings.
    """
    rows = query(
        "SELECT ts, event_type, payload FROM telemetry "
        "WHERE session_id=? ORDER BY ts ASC, id ASC",
        (session_id,),
    )
    out: list[dict[str, Any]] = []
    for r in rows:
        try:
            payload = json.loads(r["payload"]) if r["payload"] else {}
        except Exception:
            payload = {}
        out.append({"ts": r["ts"], "event_type": r["event_type"], "payload": payload})
    return out


def _load_counters(session_id: str) -> dict[str, int]:
    """Per-session typed/pasted/ai_applied character counters from sessions."""
    rows = query(
        "SELECT typed_chars, pasted_chars, ai_applied_chars "
        "FROM sessions WHERE id=?",
        (session_id,),
    )
    if not rows:
        return {"typed_chars": 0, "pasted_chars": 0, "ai_applied_chars": 0}
    r = rows[0]
    return {
        "typed_chars": int(r.get("typed_chars") or 0),
        "pasted_chars": int(r.get("pasted_chars") or 0),
        "ai_applied_chars": int(r.get("ai_applied_chars") or 0),
    }


# ─── Per-signal scorers ──────────────────────────────────────────────────────


def _score_test_after_apply(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Per rubric: applies followed by a test_run within 90s.

    >0.80 → 9.5, 0.50–0.80 → 7, 0.30–0.50 → 5, (0, 0.30] → 3, 0 → 1.
    No applies → 7 (neutral, candidate didn't use AI so there's nothing to verify).
    """
    applies = [e for e in events if e["event_type"] == "edit_ai_applied"]
    if not applies:
        return {"score": 7.0, "ratio": None, "applies": 0, "covered": 0,
                "reason": "no AI applies in session — neutral score"}
    covered = 0
    test_runs = [e["ts"] for e in events if e["event_type"] == "test_run"]
    for a in applies:
        window_end = a["ts"] + _TEST_AFTER_APPLY_WINDOW_MS
        if any(a["ts"] <= t <= window_end for t in test_runs):
            covered += 1
    ratio = covered / len(applies)
    if ratio > 0.80:
        score = 9.5
    elif ratio > 0.50:
        score = 7.0
    elif ratio > 0.30:
        score = 5.0
    elif ratio > 0:
        score = 3.0
    else:
        score = 1.0
    return {"score": score, "ratio": round(ratio, 3),
            "applies": len(applies), "covered": covered}


def _score_apply_then_edit(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Per rubric: apply followed by edit carrying post_apply_of=<block_id>.

    Looks for edit_typed / edit_pasted events whose payload.post_apply_of
    matches the block_id of any prior edit_ai_applied.
    """
    applies = [e for e in events if e["event_type"] == "edit_ai_applied"]
    if not applies:
        return {"score": 7.0, "rate": None, "applies": 0, "reviewed": 0,
                "reason": "no AI applies — neutral"}
    apply_block_ids = {
        e["payload"].get("block_id") for e in applies if e["payload"].get("block_id")
    }
    reviewed_block_ids: set[str] = set()
    for e in events:
        if e["event_type"] not in ("edit_typed", "edit_pasted"):
            continue
        block_id = e["payload"].get("post_apply_of")
        if block_id and block_id in apply_block_ids:
            reviewed_block_ids.add(block_id)
    reviewed = len(reviewed_block_ids)
    applies_with_id = max(1, len(apply_block_ids))  # avoid div-by-zero
    rate = reviewed / applies_with_id
    if rate > 0.50:
        score = 9.0
    elif rate > 0.25:
        score = 7.0
    elif rate > 0.10:
        score = 5.0
    elif rate > 0:
        score = 3.0
    else:
        score = 2.0  # never edited any AI-applied block
    return {"score": score, "rate": round(rate, 3),
            "applies": len(apply_block_ids), "reviewed": reviewed}


def _score_self_authored(counters: dict[str, int]) -> dict[str, Any]:
    """typed / (typed + ai_applied) chars. Healthy band 0.40–0.70."""
    typed = counters["typed_chars"]
    ai_applied = counters["ai_applied_chars"]
    total = typed + ai_applied
    if total == 0:
        return {"score": 5.0, "ratio": None, "typed_chars": 0,
                "ai_applied_chars": 0, "reason": "no edits — neutral"}
    ratio = typed / total
    if 0.40 <= ratio <= 0.70:
        score = 9.0
    elif 0.30 <= ratio < 0.40 or 0.70 < ratio <= 0.85:
        score = 7.0
    elif 0.20 <= ratio < 0.30 or 0.85 < ratio <= 0.95:
        score = 5.0
    else:
        score = 3.0
    return {"score": score, "ratio": round(ratio, 3),
            "typed_chars": typed, "ai_applied_chars": ai_applied}


def _score_incremental(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Smaller applies + at least one test_run between consecutive applies → higher.

    Combines two heuristics:
      1. Mean bytes per apply — smaller = more incremental.
      2. Fraction of consecutive apply-pairs with ≥1 test_run between them.

    The bytes-per-apply heuristic is the primary anchor; the test-between
    fraction is a small bonus that lifts the score by up to +1.
    """
    applies = [e for e in events if e["event_type"] == "edit_ai_applied"]
    if not applies:
        return {"score": 7.0, "applies": 0, "mean_chars": None,
                "test_between_rate": None, "reason": "no AI applies — neutral"}
    sizes = [int(e["payload"].get("chars") or 0) for e in applies]
    sizes = [s for s in sizes if s > 0] or [0]
    mean_chars = statistics.mean(sizes)

    if mean_chars < 200:
        base = 8.0
    elif mean_chars < 500:
        base = 7.0
    elif mean_chars < 2000:
        base = 5.0
    else:
        base = 3.0  # massive blocks

    test_ts = sorted(e["ts"] for e in events if e["event_type"] == "test_run")
    pairs = list(zip(applies, applies[1:]))
    if pairs:
        with_test_between = sum(
            1 for a, b in pairs if any(a["ts"] < t < b["ts"] for t in test_ts)
        )
        between_rate = with_test_between / len(pairs)
    else:
        between_rate = 0.0
    bonus = round(between_rate, 2)  # 0.0–1.0 lift

    score = min(10.0, base + bonus)
    return {
        "score": round(score, 2),
        "applies": len(applies),
        "mean_chars": round(mean_chars, 1),
        "test_between_rate": round(between_rate, 3),
    }


def _score_pre_submit(
    events: list[dict[str, Any]], submitted_at_ms: int | None
) -> dict[str, Any]:
    """Boolean floor: any test_run in the 5 min before submission."""
    if submitted_at_ms is None:
        # No submission timestamp recorded — treat as not-yet-applicable.
        # Composite still uses the other signals; the floor isn't tripped.
        return {"passed": True, "score": 7.0, "reason": "no submitted_at — floor not enforced"}
    window_start = submitted_at_ms - _PRE_SUBMIT_TEST_WINDOW_MS
    passed = any(
        e["event_type"] == "test_run" and window_start <= e["ts"] <= submitted_at_ms
        for e in events
    )
    return {
        "passed": passed,
        "score": 10.0 if passed else 1.0,
        "window_start_ms": window_start,
        "submitted_at_ms": submitted_at_ms,
    }
