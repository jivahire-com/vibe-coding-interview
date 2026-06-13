"""
Verification Discipline rubric (GRADING_METRICS_MAP.md §2A).

"Did they check their own work?" — runs the tests as they go, reviews changes
instead of trusting them blindly, and runs the tests once more before submitting.

Deterministic. A pure consumer of Layer-2 :class:`signals.Signals` — it does no
telemetry derivation of its own. It applies its weighting to the relevant signal
facts, maps each to a strong/weak/missing verdict, and emits one holistic 1-10
score (capped at 6 unless a test ran in the 5 min before submitting).

On the vibe track the signals are AI-apply-keyed; on the non-AI track they fall
back to the hand-edit cadence (`test_after_edit`, `incremental_edit`,
self-authored = 100%).
"""

from __future__ import annotations

from typing import Any

from vibe.grader.rubric_common import subpoint
from vibe.grader.signals import Signals

_PRE_SUBMIT_FLOOR_CAP = 6.0

_WEIGHTS_VIBE = {
    "test_after_apply_ratio": 0.40,
    "apply_then_edit_rate": 0.25,
    "self_authored_ratio": 0.20,
    "incremental_apply_pattern": 0.15,
}
_WEIGHTS_NON_AI = {
    "test_after_edit_ratio": 0.50,
    "self_authored_ratio": 0.25,
    "incremental_pattern": 0.25,
}


def score(signals: Signals) -> dict[str, Any]:
    if signals.ai_assistance:
        subs, weighted = _vibe_subpoints(signals)
    else:
        subs, weighted = _non_ai_subpoints(signals)

    floor_applied = not signals.pre_submit_test_run.get("passed", True)
    final = min(weighted, _PRE_SUBMIT_FLOOR_CAP) if floor_applied else weighted
    note = (
        "Pre-submit floor applied: capped at 6.0 because no test run landed in "
        "the five minutes before submitting."
        if floor_applied else None
    )
    return {"score": round(float(final), 2), "subpoints": subs, "note": note}


# ─── Vibe-track subpoints (AI-apply-keyed) ───────────────────────────────────


def _vibe_subpoints(s: Signals) -> tuple[list[dict[str, Any]], float]:
    taa = s.test_after_apply
    ate = s.apply_then_edit
    inc = s.incremental_apply

    sc_taa = _band_test_after(taa.get("ratio"))
    sc_ate = _band_apply_then_edit(ate.get("rate"))
    sc_self = _band_self_authored(s.self_authored_ratio)
    sc_inc = _band_incremental(inc.get("mean_chars"), inc.get("between_rate"))

    weighted = (
        sc_taa * _WEIGHTS_VIBE["test_after_apply_ratio"]
        + sc_ate * _WEIGHTS_VIBE["apply_then_edit_rate"]
        + sc_self * _WEIGHTS_VIBE["self_authored_ratio"]
        + sc_inc * _WEIGHTS_VIBE["incremental_apply_pattern"]
    )
    subs = [
        subpoint("test_after_apply_ratio", "Tests are run soon after accepting a change.",
                 sc_taa, _taa_detail(taa)),
        subpoint("apply_then_edit_rate", "Accepted code is reviewed and edited, not trusted blindly.",
                 sc_ate, _ate_detail(ate)),
        subpoint("self_authored_ratio", "A healthy share of the code is hand-written.",
                 sc_self, _self_detail(s.self_authored_ratio)),
        subpoint("incremental_apply_pattern", "Changes land in small steps, not one big paste.",
                 sc_inc, _inc_detail(inc)),
    ]
    return subs, weighted


def _non_ai_subpoints(s: Signals) -> tuple[list[dict[str, Any]], float]:
    tae = s.test_after_edit
    inc = s.incremental_edit

    sc_tae = _band_test_after(tae.get("ratio"), neutral=5.0)
    sc_self = 9.0  # 100% hand-authored on this track
    sc_inc = _band_incremental_edit(inc.get("mean_chars"))

    weighted = (
        sc_tae * _WEIGHTS_NON_AI["test_after_edit_ratio"]
        + sc_self * _WEIGHTS_NON_AI["self_authored_ratio"]
        + sc_inc * _WEIGHTS_NON_AI["incremental_pattern"]
    )
    subs = [
        subpoint("test_after_edit_ratio", "Tests are run soon after a hand edit.",
                 sc_tae, _tae_detail(tae)),
        subpoint("self_authored_ratio", "The work is genuinely hand-written.",
                 sc_self, "100% hand-authored on this track."),
        subpoint("incremental_pattern", "Changes land in small steps.",
                 sc_inc, _ince_detail(inc)),
    ]
    return subs, weighted


# ─── Banding (the rubric's judgment) ─────────────────────────────────────────


def _band_test_after(ratio: float | None, *, neutral: float = 7.0) -> float:
    if ratio is None:
        return neutral
    if ratio > 0.80:
        return 9.5
    if ratio > 0.50:
        return 7.0
    if ratio > 0.30:
        return 5.0
    if ratio > 0:
        return 3.0
    return 1.0


def _band_apply_then_edit(rate: float | None) -> float:
    if rate is None:
        return 7.0
    if rate > 0.50:
        return 9.0
    if rate > 0.25:
        return 7.0
    if rate > 0.10:
        return 5.0
    if rate > 0:
        return 3.0
    return 2.0


def _band_self_authored(ratio: float | None) -> float:
    if ratio is None:
        return 5.0
    if 0.40 <= ratio <= 0.70:
        return 9.0
    if 0.30 <= ratio < 0.40 or 0.70 < ratio <= 0.85:
        return 7.0
    if 0.20 <= ratio < 0.30 or 0.85 < ratio <= 0.95:
        return 5.0
    return 3.0


def _band_incremental(mean_chars: float | None, between_rate: float | None) -> float:
    if mean_chars is None:
        return 7.0
    if mean_chars < 200:
        base = 8.0
    elif mean_chars < 500:
        base = 7.0
    elif mean_chars < 2000:
        base = 5.0
    else:
        base = 3.0
    return min(10.0, base + round(between_rate or 0.0, 2))


def _band_incremental_edit(mean_chars: float | None) -> float:
    if mean_chars is None:
        return 7.0
    if mean_chars < 400:
        return 8.0
    if mean_chars < 1200:
        return 6.0
    if mean_chars < 3000:
        return 5.0
    return 3.0


# ─── Evidence strings ────────────────────────────────────────────────────────


def _taa_detail(taa: dict[str, Any]) -> str:
    if taa.get("ratio") is None:
        return "No AI applies in this session — nothing to verify."
    return f"{taa['covered']} of {taa['applies']} applies were followed by a test within 90s."


def _ate_detail(ate: dict[str, Any]) -> str:
    if ate.get("rate") is None:
        return "No AI applies in this session."
    return f"{ate['reviewed']} of {ate['applies']} applied blocks were edited within 90s."


def _self_detail(ratio: float | None) -> str:
    if ratio is None:
        return "No edits recorded."
    band = "inside the 0.40–0.70 band" if 0.40 <= ratio <= 0.70 else "outside the 0.40–0.70 band"
    return f"Typed/(typed+AI) = {ratio:.2f}, {band}."


def _inc_detail(inc: dict[str, Any]) -> str:
    if inc.get("mean_chars") is None:
        return "No AI applies in this session."
    return (f"Mean {inc['mean_chars']:.0f} chars/apply across {inc['applies']} applies; "
            f"test-between rate {inc.get('between_rate') or 0:.2f}.")


def _tae_detail(tae: dict[str, Any]) -> str:
    if tae.get("ratio") is None:
        return "No hand-edit bursts recorded."
    return f"{tae['covered']} of {tae['bursts']} edit bursts were followed by a test within 90s."


def _ince_detail(inc: dict[str, Any]) -> str:
    if inc.get("mean_chars") is None:
        return "No hand-edit bursts recorded."
    return f"Mean {inc['mean_chars']:.0f} chars across {inc['bursts']} edit bursts."
