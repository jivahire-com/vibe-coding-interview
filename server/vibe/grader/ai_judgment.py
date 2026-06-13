"""
AI Judgment rubric (GRADING_METRICS_MAP.md §2B) — vibe coding only.

"Did they judge the AI's output?" — rejects wrong suggestions, edits AI code
after accepting it, recovers from bad changes. Deterministic; a pure consumer of
Layer-2 :class:`signals.Signals` (no telemetry derivation here). Not scored on
the non-AI track.

Sub-signals → strong/weak/missing verdicts, weighted into one holistic 1-10:
  explicit_rejections 0.30, modify_after_apply 0.30, hand_fixed_traps 0.25,
  recovery_events 0.15.
"""

from __future__ import annotations

from typing import Any

from vibe.grader.rubric_common import subpoint
from vibe.grader.signals import Signals

_WEIGHTS = {
    "explicit_rejections": 0.30,
    "modify_after_apply": 0.30,
    "hand_fixed_traps": 0.25,
    "recovery_events": 0.15,
}


def score(signals: Signals) -> dict[str, Any]:
    sc_rej = _band_rejections(signals.explicit_rejections)
    sc_mod = _band_modify_after_apply(signals.modify_after_apply.get("rate"))
    sc_hand = _band_hand_fixed(signals.hand_fixed_traps)
    sc_rec = _band_recovery(signals.recovery_events)

    weighted = (
        sc_rej * _WEIGHTS["explicit_rejections"]
        + sc_mod * _WEIGHTS["modify_after_apply"]
        + sc_hand * _WEIGHTS["hand_fixed_traps"]
        + sc_rec * _WEIGHTS["recovery_events"]
    )
    subs = [
        subpoint("explicit_rejections", "Wrong AI suggestions are dismissed.",
                 sc_rej, f"{signals.explicit_rejections} explicit rejection(s) recorded."),
        subpoint("modify_after_apply", "Accepted AI code is edited, not trusted as-is.",
                 sc_mod, _mod_detail(signals.modify_after_apply)),
        subpoint("hand_fixed_traps", "Traps fixed by hand, not just by the AI.",
                 sc_hand, _hand_detail(signals.hand_fixed_traps)),
        subpoint("recovery_events", "Recovers cleanly from bad changes.",
                 sc_rec, _rec_detail(signals.recovery_events)),
    ]
    return {"score": round(float(weighted), 2), "subpoints": subs, "note": None}


def _band_rejections(count: int) -> float:
    if count >= 3:
        return 9.0
    if count == 2:
        return 7.0
    if count == 1:
        return 5.0
    return 2.0


def _band_modify_after_apply(rate: float | None) -> float:
    if rate is None:
        return 7.0
    if rate >= 0.50:
        return 9.0
    if rate >= 0.25:
        return 7.0
    if rate >= 0.10:
        return 5.0
    if rate > 0:
        return 3.0
    return 1.0


def _band_hand_fixed(facts: dict[str, Any]) -> float:
    if facts.get("total", 0) == 0:
        return 5.0
    if facts.get("hand_fixed", 0) >= 1:
        return 9.0
    return 5.0 if facts.get("any_reviewed") else 3.0


def _band_recovery(facts: dict[str, Any]) -> float:
    count = facts.get("count", 0)
    if count == 0:
        return 5.0
    if count <= 2:
        return 9.0
    if count <= 5:
        return 7.0
    return 4.0


def _mod_detail(facts: dict[str, Any]) -> str:
    if facts.get("rate") is None:
        return "No AI applies in this session."
    return f"{facts['reviewed']} of {facts['applies']} applied blocks edited within 90s."


def _hand_detail(facts: dict[str, Any]) -> str:
    if facts.get("total", 0) == 0:
        return "No traps detected — nothing to attribute (neutral)."
    return f"{facts.get('hand_fixed', 0)} of {facts['total']} fixed traps were hand-authored."


def _rec_detail(facts: dict[str, Any]) -> str:
    if not facts.get("available", False):
        return "Git history unavailable — neutral signal."
    count = facts.get("count", 0)
    if count == 0:
        return "No resets or large reverts recorded — nothing to recover from (neutral)."
    return f"{count} recovery event(s) (revert/reset or large deletion)."
