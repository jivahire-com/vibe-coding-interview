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


def subpoint(key: str, checks: str, score: float | None, detail: str,
             *, strong: float = 7.0, weak: float = 4.0) -> dict[str, Any]:
    """Build one report subpoint from an internal sub-score + evidence."""
    return {
        "key": key,
        "checks": checks,
        "verdict": verdict_from_score(score, strong=strong, weak=weak),
        "detail": detail,
    }
