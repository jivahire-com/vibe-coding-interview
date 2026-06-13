"""
Developer-signal rubric (GRADING_METRICS_MAP.md §2A) — scored on both tracks.

"Did they behave like a developer?" — opens and reads the relevant files, and
runs the tests. Folded into the /100 (weight 10) on both tracks; the debugger is
a bonus that lifts this score and never penalises its absence.

A pure consumer of Layer-2 :class:`signals.Signals`. The natural scale of the
developer formula is 0-100; the rubric emits the equivalent 1-10 holistic
(``score = dev_0_100 / 10``) so it flows through the same ×10 step as every other
rubric in ``report.py``. The 0-100 value still maps to the recruiter verdict
(developer ≥ 60, uncertain ≥ 35, else non-developer).
"""

from __future__ import annotations

from typing import Any

from vibe.grader.rubric_common import subpoint
from vibe.grader.signals import Signals

_DEBUGGER_BONUS = 15


def score(signals: Signals, client: Any | None = None,
          session_id: str | None = None) -> dict[str, Any]:
    if signals.ai_assistance:
        dev_0_100, subs = _vibe(signals)
    else:
        dev_0_100, subs = _non_ai(signals)

    dev_0_100 = min(round(dev_0_100), 100)
    verdict = "developer" if dev_0_100 >= 60 else "uncertain" if dev_0_100 >= 35 else "non_developer"
    reasoning = _reasoning(client, dev_0_100, verdict, signals, session_id)

    return {
        "score": round(dev_0_100 / 10.0, 2),   # 1-10 holistic; report ×10 → 0-100
        "subpoints": subs,
        "note": None,
        "verdict_label": verdict,
        "dev_score_0_100": dev_0_100,
        "reasoning": reasoning,
    }


def _vibe(s: Signals) -> tuple[float, list[dict[str, Any]]]:
    files = min(s.files_explored / 5, 1.0)
    rework = s.ai_output_modified_ratio
    spec = s.prompt_specificity or 0.0
    tests = min(s.test_runs / 3, 1.0)

    base = files * 15 + rework * 20 + spec * 30 + tests * 10  # max 75
    bonus = _DEBUGGER_BONUS if s.used_debugger else 0
    total = base + bonus

    subs = [
        subpoint("files_explored", "Reads the relevant files.",
                 files * 10, f"Opened {s.files_explored} file(s)."),
        subpoint("ai_output_modified_ratio", "Reworks AI output rather than rubber-stamping it.",
                 rework * 10, f"Edited {round(rework * 100)}% of accepted AI characters."),
        subpoint("prompt_specificity", "Prompts are specific, not vague.",
                 (spec * 10) if s.prompt_specificity is not None else None,
                 _spec_detail(s.prompt_specificity)),
        subpoint("test_runs", "Runs the test suite during the session.",
                 tests * 10, f"Ran the suite {s.test_runs} time(s)."),
        _debugger_subpoint(s.used_debugger),
    ]
    return total, subs


def _non_ai(s: Signals) -> tuple[float, list[dict[str, Any]]]:
    files = min(s.files_explored / 5, 1.0)
    tests = min(s.test_runs / 3, 1.0)
    base = files * 37.5 + tests * 37.5  # rescaled to fill the 75-pt base
    bonus = _DEBUGGER_BONUS if s.used_debugger else 0
    total = base + bonus

    subs = [
        subpoint("files_explored", "Reads the relevant files.",
                 files * 10, f"Opened {s.files_explored} file(s)."),
        subpoint("test_runs", "Runs the test suite during the session.",
                 tests * 10, f"Ran the suite {s.test_runs} time(s)."),
        _debugger_subpoint(s.used_debugger),
    ]
    return total, subs


def _debugger_subpoint(used: bool) -> dict[str, Any]:
    return {
        "key": "debugger_bonus",
        "checks": "Bonus — used the debugger to investigate.",
        "verdict": "strong" if used else "missing",
        "detail": ("Started the debugger; lifts this score (never a penalty if absent)."
                   if used else "Debugger not used — observation only, no penalty."),
    }


def _spec_detail(spec: float | None) -> str:
    if spec is None:
        return "No chat prompts recorded."
    return f"{round(spec * 100)}% of prompts used code-specific terms."


def _reasoning(client: Any | None, dev_0_100: int, verdict: str,
               s: Signals, session_id: str | None) -> str:
    fallback = f"Behavioral signal: {verdict} ({dev_0_100}/100)."
    if client is None:
        return fallback
    from vibe.grader.llm_eval import _commentary_call
    prompt = (
        "Summarise in 1-2 plain sentences whether a candidate behaved like a practicing "
        "developer during a coding interview, from the signals below. Do not invent facts; "
        "do not output a score.\n\n"
        f"Verdict: {verdict} ({dev_0_100}/100)\n"
        f"Files explored: {s.files_explored}\n"
        f"AI output reworked: {s.ai_output_modified_ratio}\n"
        f"Prompt specificity: {s.prompt_specificity}\n"
        f"Test runs: {s.test_runs}\n"
        f"Used debugger: {s.used_debugger}\n"
    )
    return _commentary_call(client, prompt, fallback=fallback, session_id=session_id)


def debugger_bonus(signals: Signals) -> dict[str, Any]:
    """Report bonus card for debugger usage (lifts developer signal)."""
    used = signals.used_debugger
    return {
        "key": "debugger",
        "title": "Debugger usage",
        "attempted": used,
        "lifts": "developer signal",
        "note": (
            "Started the debugger to investigate. Counts as a bonus that lifts the "
            "developer-signal score — skipping it is never a penalty."
            if used else
            "Debugger not used. Reported as an observation only — never a penalty."
        ),
    }
