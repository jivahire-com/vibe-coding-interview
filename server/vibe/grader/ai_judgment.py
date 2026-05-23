"""
AI Judgment & Rejection (8% of composite).

Telemetry- and git-derived signal of whether the candidate can recognise bad
AI output and disagree with the model. Per GRADING_RUBRICS.md, "the can-they-
disagree-with-the-model signal."

Sub-signals (deterministic):
  - explicit_rejections   — count of `edit_ai_rejected` events
  - modify_after_apply    — fraction of AI applies followed by a post_apply_of
                             edit (proxy for "candidate validated the fix")
  - hand_fixed_traps      — fraction of detected traps attributed to hand-fix
                             (from `trap_attribution.classify`)
  - recovery_events       — large reverts / `git reset` on the candidate branch

The LLM correction-prompt sub-evaluator from the rubric is deferred (the four
deterministic signals already cover most of the dimension and avoid extra LLM
spend on every grading run). A hook is left in `breakdown["llm_subevaluator"]`
so it can be wired in later without changing the public surface.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from vibe.db import query

_WEIGHTS = {
    "explicit_rejections": 0.30,
    "modify_after_apply": 0.30,
    "hand_fixed_traps": 0.25,
    "recovery_events": 0.15,
}
_LARGE_REVERT_LINE_THRESHOLD = 50


def compute(
    session_id: str,
    clone_dir: Path | None,
    attribution: dict[str, Any] | None,
) -> dict[str, Any]:
    """Return {score, breakdown}.

    `attribution` is the dict returned by `trap_attribution.classify` (used for
    the hand_fixed_traps sub-signal). Pass `None` if attribution wasn't run.
    `clone_dir` is the candidate's cloned repo; pass `None` to skip the
    git-based recovery_events signal.
    """
    events = _load_events(session_id)

    signals: dict[str, dict[str, Any]] = {
        "explicit_rejections": _score_rejections(events),
        "modify_after_apply": _score_modify_after_apply(events),
        "hand_fixed_traps": _score_hand_fixed_traps(attribution),
        "recovery_events": _score_recovery_events(clone_dir),
        "llm_subevaluator": {"enabled": False, "reason": "deferred to future enhancement"},
    }

    score = sum(signals[k]["score"] * w for k, w in _WEIGHTS.items())
    return {
        "score": round(float(score), 2),
        "breakdown": {"signals": signals, "weights": _WEIGHTS},
    }


# ─── Loaders ──────────────────────────────────────────────────────────────────


def _load_events(session_id: str) -> list[dict[str, Any]]:
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


# ─── Per-signal scorers ──────────────────────────────────────────────────────


def _score_rejections(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Per rubric: explicit rejection is the strongest "no, I disagree" signal."""
    count = sum(1 for e in events if e["event_type"] == "edit_ai_rejected")
    if count >= 3:
        score = 9.0
    elif count == 2:
        score = 7.0
    elif count == 1:
        score = 5.0
    else:
        score = 2.0  # zero rejections is damning per rubric
    return {"score": score, "count": count}


def _score_modify_after_apply(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Proxy for "candidate validated the AI fix."

    True semantic-edit-distance ≥30% needs the original applied text — which we
    don't reliably have post-apply because the file evolves. The post_apply_of
    field on subsequent edits is a strong proxy: a typed edit attached to an
    applied block within 90s = the candidate touched the AI output.
    """
    apply_blocks: set[str] = set()
    reviewed_blocks: set[str] = set()
    for e in events:
        if e["event_type"] == "edit_ai_applied":
            bid = e["payload"].get("block_id")
            if isinstance(bid, str):
                apply_blocks.add(bid)
        elif e["event_type"] in ("edit_typed", "edit_pasted"):
            bid = e["payload"].get("post_apply_of")
            if isinstance(bid, str):
                reviewed_blocks.add(bid)

    if not apply_blocks:
        return {"score": 7.0, "rate": None, "applies": 0,
                "reason": "no AI applies — neutral"}
    rate = len(reviewed_blocks & apply_blocks) / len(apply_blocks)
    if rate >= 0.50:
        score = 9.0
    elif rate >= 0.25:
        score = 7.0
    elif rate >= 0.10:
        score = 5.0
    elif rate > 0:
        score = 3.0
    else:
        score = 1.0  # accepted every apply verbatim
    return {
        "score": score,
        "rate": round(rate, 3),
        "applies": len(apply_blocks),
        "reviewed": len(reviewed_blocks & apply_blocks),
    }


def _score_hand_fixed_traps(
    attribution: dict[str, Any] | None,
) -> dict[str, Any]:
    """At least one hand-fixed trap is the rubric's strongest independence signal."""
    if not attribution:
        return {"score": 5.0, "hand_fixed": 0, "total": 0,
                "reason": "trap_attribution missing — neutral"}
    attrs = attribution.get("attributions", {})
    if not attrs:
        return {"score": 5.0, "hand_fixed": 0, "total": 0,
                "reason": "no traps were detected — nothing to attribute"}
    hand_fixed = sum(1 for v in attrs.values() if v.get("class") == "hand-fixed")
    total = len(attrs)
    if hand_fixed >= 1:
        score = 9.0
    elif total > 0:
        # All AI-fixed → 3 (rubric scale: "Accepts nearly everything")
        # except if at least one is ai-fixed-reviewed → 5 (mid range)
        any_reviewed = any(v.get("class") == "ai-fixed-reviewed" for v in attrs.values())
        score = 5.0 if any_reviewed else 3.0
    else:
        score = 5.0
    return {"score": score, "hand_fixed": hand_fixed, "total": total}


def _score_recovery_events(clone_dir: Path | None) -> dict[str, Any]:
    """`git log` on the candidate branch → count large reverts (≥50 lines) and
    explicit `git reset`-style messages.

    Per rubric: "1 or 2 = healthy course-correction; zero often = never
    noticed." Returns a neutral score when git is unavailable so the dimension
    doesn't crater just because grader can't shell out.
    """
    if clone_dir is None or not clone_dir.exists():
        return {"score": 5.0, "count": 0, "reason": "no clone_dir — neutral"}
    try:
        log = subprocess.run(
            ["git", "log", "--all", "--pretty=%H %s", "--numstat"],
            cwd=clone_dir,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except Exception as exc:
        return {"score": 5.0, "count": 0, "reason": f"git log failed: {exc}"}

    if log.returncode != 0:
        return {"score": 5.0, "count": 0, "reason": "git log returncode != 0"}

    count = _count_recovery_commits(log.stdout)
    if count == 0:
        score = 5.0  # neutral — could mean clean run OR never noticed
    elif count <= 2:
        score = 9.0  # healthy course-correction
    elif count <= 5:
        score = 7.0
    else:
        score = 4.0  # chaos / floundering
    return {"score": score, "count": count}


def _count_recovery_commits(git_log_output: str) -> int:
    """A commit is a "recovery" if its message mentions revert/reset OR it
    deletes >= 50 lines in a single commit. Walk the `git log --numstat`
    output and count.
    """
    count = 0
    current_subject = ""
    current_deletions = 0
    current_is_commit = False

    def _flush() -> int:
        nonlocal current_subject, current_deletions, current_is_commit
        bump = 0
        if current_is_commit:
            subj = current_subject.lower()
            if "revert" in subj or "reset" in subj or "rollback" in subj:
                bump = 1
            elif current_deletions >= _LARGE_REVERT_LINE_THRESHOLD:
                bump = 1
        current_subject = ""
        current_deletions = 0
        current_is_commit = False
        return bump

    for raw_line in git_log_output.splitlines():
        line = raw_line.rstrip()
        if not line:
            continue
        # Commit header line: "<sha> <subject>" — sha is 40 hex chars.
        if len(line) > 41 and line[40] == " " and all(
            c in "0123456789abcdef" for c in line[:40]
        ):
            count += _flush()
            current_subject = line[41:]
            current_is_commit = True
            continue
        # Numstat line: "<added>\t<deleted>\t<path>"
        parts = line.split("\t")
        if len(parts) >= 2:
            try:
                current_deletions += int(parts[1])
            except ValueError:
                pass
    count += _flush()
    return count
