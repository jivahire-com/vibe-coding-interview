"""
Engagement / no-show gate.

A candidate who opens the challenge and submits without doing anything still
collects middling scores on the behavioural and LLM-graded dimensions, because:

  - the behavioural sub-signals fall back to a neutral 5/10 when there is
    nothing to measure (see verification_discipline / ai_judgment), and
  - the LLM-graded dimensions evaluate whatever code is on the branch — which
    for a no-op submission is the *unmodified starter scaffold*, so they reward
    code the candidate never wrote.

The net effect is a misleading ~3.4/10 for a candidate who did nothing.

`assess()` decides whether the candidate genuinely engaged using three
independent signals (any one of which counts as engagement, so the gate is
conservative and never floors a candidate who did real work):

  1. authored+pasted+AI-applied characters (telemetry counters), and
  2. at least one AI chat exchange, and
  3. any change to the starter on the branch (excluding the extension's own
     `.jivahire/` bookkeeping such as the committed telemetry JSONL).

When none of those fired, the runner floors every *non-objective* dimension to
`NEAR_ZERO`. We deliberately do NOT floor to 0: a hard zero reads like a grader
crash, and the objective dimensions (tests / traps) already carry the real
signal on their own.
"""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from typing import Any

from vibe.db import query
from vibe.grader.git_ops import candidate_base

log = logging.getLogger("vibe.grader")

# Floor applied to every non-objective dimension when the candidate did not
# engage. Deliberately > 0 (see module docstring).
NEAR_ZERO = 0.5

# Total authored+pasted+AI-applied characters at or below this count is treated
# as "no real edits" — covers a stray autosave or an accidental keystroke.
_MIN_ENGAGED_CHARS = 40

# The extension writes `.jivahire/telemetry.jsonl` onto the branch during the
# session, so that path shows up in a diff even when the candidate wrote no
# code. Exclude it (and anything else under `.jivahire/`) from the "did they
# change any code?" check.
_NON_CODE_PATHSPEC = ":(exclude).jivahire/**"

NO_SHOW_NOTE = (
    "Candidate did not attempt the challenge — no code edits, no AI chat, and "
    "no changes to the starter code were recorded. Non-objective dimensions "
    "have been floored."
)


def assess(session_id: str, clone_dir: Path | None) -> dict[str, Any]:
    """Return {attended: bool, reason: str|None, signals: {...}}.

    `attended` is True if ANY engagement signal fired. The authorship counters
    (typed/pasted/AI-applied chars) and chat presence are the primary guards: a
    real attempt always trips one of them. The git "code changed" signal only
    *adds* engagement when it can positively prove a code diff — it never fires
    on an unreadable diff (see `_code_changed`), so a no-show whose branch holds
    only bookkeeping commits is no longer mistaken for a real attempt.
    """
    counters = _load_counters(session_id)
    engaged_chars = (
        counters["typed_chars"]
        + counters["pasted_chars"]
        + counters["ai_applied_chars"]
    )
    has_chat = _has_chat(session_id)
    code_changed = _code_changed(clone_dir)

    attended = engaged_chars > _MIN_ENGAGED_CHARS or has_chat or code_changed
    return {
        "attended": attended,
        "reason": None if attended else NO_SHOW_NOTE,
        "signals": {
            "engaged_chars": engaged_chars,
            "has_chat": has_chat,
            "code_changed": code_changed,
        },
    }


def _load_counters(session_id: str) -> dict[str, int]:
    rows = query(
        "SELECT typed_chars, pasted_chars, ai_applied_chars FROM sessions WHERE id=?",
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


def _has_chat(session_id: str) -> bool:
    rows = query(
        "SELECT COUNT(*) AS n FROM chat_exchanges WHERE session_id=?",
        (session_id,),
    )
    return bool(rows and int(rows[0]["n"] or 0) > 0)


def _code_changed(clone_dir: Path | None) -> bool:
    """True only if the candidate's own commits *positively* changed code
    (ignoring `.jivahire/`).

    Diffs the provisioning baseline — the workspace handed to the candidate —
    against HEAD, so the starter import and the answer-key provisioning that sit
    on the branch before the candidate started are NOT mistaken for their work.
    Those setup commits (e.g. a 50+ line "update starter to canonical package"
    sync) are exactly what let a no-show read as "changed code" and slip past the
    floor.

    This is a corroborating signal, not the primary one: a real attempt always
    leaves typed/pasted/AI-applied characters in the session counters, which
    `assess()` checks independently. So when the diff cannot be computed we
    return False and let the authorship counters carry a genuine attempt.
    """
    if clone_dir is None or not Path(clone_dir).exists():
        return False
    base = candidate_base(clone_dir)
    if base is None:
        return False
    try:
        diff = subprocess.run(
            ["git", "-C", str(clone_dir), "diff", "--quiet", base, "HEAD",
             "--", ".", _NON_CODE_PATHSPEC],
            capture_output=True, timeout=30,
        )
        # `git diff --quiet` exits 0 when there is no diff, 1 when there is.
        return diff.returncode != 0
    except Exception:
        log.warning("engagement_code_diff_failed", exc_info=True)
        return False
