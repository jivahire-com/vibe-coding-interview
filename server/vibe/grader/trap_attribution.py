"""
Trap-fix attribution (feeds the Trap Detection 12% dimension + AI Judgment 8%).

Per GRADING_RUBRICS.md, for each detected trap the grader classifies the fix as
one of:

  - hand-fixed         — fix lines typed by the candidate (strongest signal)
  - ai-fixed-reviewed  — fix lines from an AI apply that the candidate then
                          edited semantically before the next commit
  - ai-fixed-blind     — fix lines from an AI apply with no follow-up edit

Trap points are awarded fully regardless of class; the attribution mix is what
the recruiter UI surfaces and what AI Judgment uses as evidence.

**Heuristic (v1).** `traps.json` does not currently carry per-trap `fix_lines`,
so we cannot do per-trap source-line provenance. We classify each detected
trap using SESSION-WIDE telemetry signals — same classification for every trap
in a session. This is coarse but correctly shapes the overall mix the
recruiter sees. A future enhancement can do per-file or per-line attribution
via `git blame` once challenges populate `fix_lines`.

  - self_authored_ratio >= 0.85       → hand-fixed
  - >=1 apply with a post_apply_of edit and reviewed_rate >= 0.30
                                       → ai-fixed-reviewed
  - else                               → ai-fixed-blind
"""

from __future__ import annotations

import json
from typing import Any

from vibe.db import query

_HAND_FIXED_RATIO = 0.85
_AI_REVIEWED_REVIEW_RATE = 0.30


def classify(session_id: str, detected_traps: list[dict[str, Any]]) -> dict[str, Any]:
    """Return {<trap_id>: {class, evidence}} for each detected trap.

    `detected_traps` is the list returned by `traps.evaluate_traps` (each item
    has at least `id` and `description`). Misses are not attributed — only
    traps the candidate actually fixed get an entry.
    """
    if not detected_traps:
        return {"attributions": {}, "session_signals": _empty_signals()}

    signals = _session_signals(session_id)
    klass, reason = _classify_from_signals(signals)

    attributions: dict[str, dict[str, Any]] = {}
    for trap in detected_traps:
        trap_id = trap.get("id") or trap.get("description") or "unknown"
        attributions[str(trap_id)] = {
            "class": klass,
            "reason": reason,
            "evidence": {
                "self_authored_ratio": signals["self_authored_ratio"],
                "apply_count": signals["apply_count"],
                "reviewed_rate": signals["reviewed_rate"],
            },
        }

    return {"attributions": attributions, "session_signals": signals}


# ─── Telemetry signals ───────────────────────────────────────────────────────


def _empty_signals() -> dict[str, Any]:
    return {
        "typed_chars": 0,
        "ai_applied_chars": 0,
        "self_authored_ratio": None,
        "apply_count": 0,
        "reviewed_block_count": 0,
        "reviewed_rate": None,
    }


def _session_signals(session_id: str) -> dict[str, Any]:
    """Aggregate the per-session counters + per-block review signal."""
    sess_rows = query(
        "SELECT typed_chars, pasted_chars, ai_applied_chars "
        "FROM sessions WHERE id=?",
        (session_id,),
    )
    typed = ai_applied = 0
    if sess_rows:
        r = sess_rows[0]
        typed = int(r.get("typed_chars") or 0)
        ai_applied = int(r.get("ai_applied_chars") or 0)
    total = typed + ai_applied
    self_ratio: float | None = (typed / total) if total > 0 else None

    tel_rows = query(
        "SELECT event_type, payload FROM telemetry "
        "WHERE session_id=? ORDER BY ts ASC, id ASC",
        (session_id,),
    )
    apply_blocks: set[str] = set()
    reviewed_blocks: set[str] = set()
    for row in tel_rows:
        try:
            payload = json.loads(row["payload"]) if row["payload"] else {}
        except Exception:
            continue
        if row["event_type"] == "edit_ai_applied":
            bid = payload.get("block_id")
            if isinstance(bid, str):
                apply_blocks.add(bid)
        elif row["event_type"] in ("edit_typed", "edit_pasted"):
            bid = payload.get("post_apply_of")
            if isinstance(bid, str):
                reviewed_blocks.add(bid)

    apply_count = len(apply_blocks)
    reviewed_block_count = len(reviewed_blocks & apply_blocks)
    reviewed_rate: float | None = (
        reviewed_block_count / apply_count if apply_count > 0 else None
    )
    return {
        "typed_chars": typed,
        "ai_applied_chars": ai_applied,
        "self_authored_ratio": round(self_ratio, 3) if self_ratio is not None else None,
        "apply_count": apply_count,
        "reviewed_block_count": reviewed_block_count,
        "reviewed_rate": round(reviewed_rate, 3) if reviewed_rate is not None else None,
    }


def _classify_from_signals(signals: dict[str, Any]) -> tuple[str, str]:
    self_ratio = signals["self_authored_ratio"]
    apply_count = signals["apply_count"]
    reviewed_rate = signals["reviewed_rate"]

    if apply_count == 0:
        # No AI applies at all in the session — fixes must have been typed.
        return "hand-fixed", "no AI applies recorded in session telemetry"

    if self_ratio is not None and self_ratio >= _HAND_FIXED_RATIO:
        return (
            "hand-fixed",
            f"self_authored_ratio={self_ratio:.2f} ≥ {_HAND_FIXED_RATIO} — typed dominates",
        )

    if reviewed_rate is not None and reviewed_rate >= _AI_REVIEWED_REVIEW_RATE:
        return (
            "ai-fixed-reviewed",
            f"{int(reviewed_rate * 100)}% of AI applies followed by post-apply edits — candidate reviewed before next commit",
        )

    return (
        "ai-fixed-blind",
        "AI applies present but no semantic follow-up edits — fix accepted without review",
    )
