"""Shared helpers for Layer-3 rubrics (GRADING_METRICS_MAP.md §2/§3).

A rubric returns one holistic 1-10 ``score`` plus a list of ``subpoints``, each a
plain-English ``{key, checks, verdict, detail}`` where ``verdict`` is one of
``strong`` / ``weak`` / ``missing`` (never a number — that is false precision).
``report.py`` multiplies the holistic score by 10 once and pairs it with the
static Good/Bad yardstick from ``grading_config.json``.
"""

from __future__ import annotations

from typing import Any


def verdict_from_score(score: float | None, *, strong: float = 7.0, weak: float = 4.0) -> str:
    """Map an internal 1-10 sub-score to a strong / weak / missing verdict."""
    if score is None:
        return "missing"
    if score >= strong:
        return "strong"
    if score >= weak:
        return "weak"
    return "missing"


def weighted_average(parts: list[tuple[float | None, float]]) -> float | None:
    """Weighted mean over ``(score, weight)`` pairs, dropping N/A entries.

    A part whose ``score`` is ``None`` has no evidence behind it (e.g. a check
    that only applies once the candidate accepted AI code, in a session with no
    such accepts). Such parts are *not* folded in as a neutral value — that would
    let "nothing to judge" read as a passing score. They are dropped and the
    remaining weights re-normalised. Returns ``None`` when every part is N/A, so
    the rubric itself becomes N/A and report.py drops it from the overall total.
    """
    live = [(s, w) for s, w in parts if s is not None]
    denom = sum(w for _, w in live)
    if not denom:
        return None
    return sum(s * w for s, w in live) / denom


def subpoint(key: str, checks: str, score: float | None, detail: str,
             *, strong: float = 7.0, weak: float = 4.0,
             na_when_none: bool = False) -> dict[str, Any]:
    """Build one report subpoint from an internal sub-score + evidence.

    With ``na_when_none`` a ``None`` score renders as the ``na`` verdict ("no
    evidence to judge") rather than ``missing`` ("applies but not done") — the
    honest reading when the check had nothing to measure.
    """
    verdict = "na" if (na_when_none and score is None) \
        else verdict_from_score(score, strong=strong, weak=weak)
    return {
        "key": key,
        "checks": checks,
        "verdict": verdict,
        "detail": detail,
    }
