"""
Grading runner — orchestrates the full pipeline for a submitted session.

Pipeline (per GRADING_RUBRICS.md):
  1. clone the candidate's branch
  2. build + run the hidden test suite (per-tag pass/fail)
  3. trap detection (`traps.evaluate_traps`)
  4. trap attribution (hand-fixed / ai-fixed-reviewed / ai-fixed-blind)
  5. LLM-graded dimensions (Code Quality, LLM Communication, Arch Reasoning)
  6. Telemetry-derived dimensions (Verification Discipline, AI Judgment)
  7. Challenge-specific bonus
  8. Composite weighted sum across the 8 dimensions

The composite weights below come straight from GRADING_RUBRICS.md and must sum
to 1.0; deviations indicate a config drift and should be caught immediately.
"""

from __future__ import annotations

import json
import logging
import shutil
import time
import traceback as tb_module
from pathlib import Path
from typing import Any

from openai import OpenAI

from vibe.config import repo_for_challenge, settings
from vibe.db import execute, query
from vibe.grader import (
    ai_judgment,
    challenge_specific,
    cpp_runner,
    developer_signals,
    llm_eval,
    python_runner,
    trap_attribution,
    traps as traps_module,
    typescript_runner,
    verification_discipline,
)
from vibe.grader.git_ops import clone_branch
from vibe.grader import telemetry_ingest as _telemetry_ingest

log = logging.getLogger("vibe.grader")

_STAGE_MESSAGES = {
    "clone": "We could not access your submission repository. Please contact support.",
    "build": "We could not build your submission. Please contact support.",
    "traps": "An error occurred during trap evaluation. Please contact support.",
    "attribution": "Trap attribution could not be computed; grade unaffected.",
    "llm_eval": "AI grading is temporarily unavailable. Please contact support.",
    "verification_discipline": "Verification-discipline scoring failed; grade unaffected.",
    "ai_judgment": "AI-judgment scoring failed; grade unaffected.",
    "challenge_specific": "Challenge-specific bonus failed; grade unaffected.",
    "developer_confidence": "Developer-signal computation failed; grade is unaffected.",
    "telemetry_ingest": "Could not read telemetry from your submission; some scoring may use partial data.",
}

_GRADER_BACKENDS = {
    "cpp": cpp_runner,
    "python": python_runner,
    "typescript": typescript_runner,
}

# Per GRADING_RUBRICS.md. Must sum to 1.0.
COMPOSITE_WEIGHTS = {
    "tests":                   0.20,
    "traps":                   0.12,
    "verification_discipline": 0.13,
    "ai_judgment":             0.08,
    "llm_communication":       0.17,
    "code_quality":            0.15,
    "architectural_reasoning": 0.10,
    "challenge_specific":      0.05,
}

_FALLBACK = 5.0


def _load_challenge_config(challenge_dir: Path) -> tuple[dict, dict, list[str]]:
    metadata = json.loads((challenge_dir / ".jivahire" / "metadata.json").read_text())
    try:
        rubric = json.loads((challenge_dir / ".jivahire" / "rubric.json").read_text())
    except Exception:
        rubric = {}
    try:
        traps_data = json.loads((challenge_dir / ".jivahire" / "traps.json").read_text())
    except Exception:
        traps_data = {"traps": []}
    tags = sorted(
        {t["test_tag"] for t in rubric.get("tasks", []) if t.get("test_tag")}
        | {t["detection_tag"] for t in traps_data.get("traps", []) if t.get("detection_tag")}
    )
    return metadata, rubric, tags


def run(session_id: str) -> None:
    rows = query("SELECT * FROM sessions WHERE id=?", (session_id,))
    if not rows:
        raise ValueError(f"Session {session_id} not found")
    session = rows[0]
    started = time.time()
    log.info(
        "grading_started",
        extra={"context": {"session_id": session_id, "challenge_id": session["challenge_id"]}},
    )

    clone_dir = Path(f"/tmp/grade-{session_id}")
    if clone_dir.exists():
        shutil.rmtree(clone_dir)

    try:
        # ── 1. Clone ───────────────────────────────────────────────────────
        try:
            clone_branch(repo_for_challenge(session["challenge_id"]), session["branch_name"], clone_dir)
        except Exception:
            _record_error(session_id, "clone")
            execute("UPDATE sessions SET status='grading_failed' WHERE id=?", (session_id,))
            return

        # ── 1.5. Ingest telemetry JSONL ───────────────────────────────────
        try:
            _telemetry_ingest.ingest(session_id, clone_dir)
        except Exception:
            _record_error(session_id, "telemetry_ingest")
            # Non-fatal: downstream stages fall back to whatever rows are in the DB

        challenge_dir = Path(settings.challenges_dir) / session["challenge_id"]

        # ── 2. Build + run hidden tests ───────────────────────────────────
        try:
            metadata, rubric, tags = _load_challenge_config(challenge_dir)
            hidden_test = challenge_dir / metadata["hidden_test_file"]
            backend = _GRADER_BACKENDS[metadata["grader"]]
            tag_results, raw_output = backend.build_and_test(clone_dir, hidden_test, tags)
        except Exception:
            _record_error(session_id, "build")
            tag_results, raw_output, rubric = {}, "", {}

        # ── 3. Trap detection ─────────────────────────────────────────────
        try:
            traps_detected, traps_total, detected_traps, missed_traps, traps_detected_w, traps_total_w = \
                traps_module.evaluate_traps(challenge_dir, tag_results)
        except Exception:
            _record_error(session_id, "traps")
            traps_detected, traps_total, detected_traps, missed_traps, traps_detected_w, traps_total_w = \
                0, 0, [], [], 0, 0

        # ── 4. Trap attribution ───────────────────────────────────────────
        try:
            attribution = trap_attribution.classify(session_id, detected_traps)
        except Exception:
            _record_error(session_id, "attribution")
            attribution = {"attributions": {}, "session_signals": {}}

        # ── 5. LLM-graded dimensions ──────────────────────────────────────
        try:
            llm_dims = llm_eval.evaluate(
                session_id, session["challenge_id"], tag_results, clone_dir,
                detected_traps, missed_traps,
            )
        except Exception:
            _record_error(session_id, "llm_eval")
            llm_dims = _llm_fallback()

        # ── 6. Telemetry-derived dimensions ───────────────────────────────
        try:
            vd = verification_discipline.compute(session_id, session.get("submitted_at"))
        except Exception:
            _record_error(session_id, "verification_discipline")
            vd = {"score": _FALLBACK, "breakdown": {"reason": "computation failed"}}

        try:
            aj = ai_judgment.compute(session_id, clone_dir, attribution)
        except Exception:
            _record_error(session_id, "ai_judgment")
            aj = {"score": _FALLBACK, "breakdown": {"reason": "computation failed"}}

        # ── 7. Challenge-specific bonus ───────────────────────────────────
        try:
            cs = challenge_specific.compute(session["challenge_id"], clone_dir, rubric)
        except Exception:
            _record_error(session_id, "challenge_specific")
            cs = {"score": _FALLBACK, "breakdown": {"reason": "computation failed"}}

        # ── 8. Composite ──────────────────────────────────────────────────
        tags_passed = sum(1 for v in tag_results.values() if v)
        tests_total = len(tag_results)
        tests_score = (tags_passed / tests_total * 10) if tests_total else 0
        traps_score = (traps_detected_w / traps_total_w * 10) if traps_total_w else 0

        dim_scores = {
            "tests": tests_score,
            "traps": traps_score,
            "verification_discipline": vd["score"],
            "ai_judgment": aj["score"],
            "llm_communication": llm_dims["llm_communication"]["score"],
            "code_quality": llm_dims["code_quality"]["score"],
            "architectural_reasoning": llm_dims["architectural_reasoning"]["score"],
            "challenge_specific": cs["score"],
        }
        total_score, composite_breakdown = _composite(dim_scores)
        grader_summary = _build_summary(
            dim_scores,
            tests_passed=tags_passed, tests_total=tests_total,
            traps_detected=traps_detected, traps_total=traps_total,
            llm_dims=llm_dims, vd=vd, aj=aj, cs=cs,
        )

        # Developer-confidence signal — independent of grading, recruiter-only.
        try:
            dev_client = OpenAI(api_key=settings.openai_api_key, base_url=settings.llm_base_url)
            dev_conf = developer_signals.compute_developer_confidence(session_id, dev_client)
        except Exception:
            _record_error(session_id, "developer_confidence")
            dev_conf = {"score": None, "verdict": None, "signals": None, "reasoning": None}

        execute(
            "INSERT OR REPLACE INTO grades "
            "(session_id, tests_passed, tests_total, traps_detected, traps_total, "
            " code_quality_score, code_quality_breakdown, "
            " architectural_reasoning_score, architectural_reasoning_breakdown, "
            " llm_communication_score, llm_communication_breakdown, "
            " verification_discipline_score, verification_discipline_breakdown, "
            " ai_judgment_score, ai_judgment_breakdown, "
            " challenge_specific_score, challenge_specific_breakdown, "
            " trap_attribution, composite_breakdown, "
            " total_score, grader_summary, raw_output, "
            " developer_confidence_score, developer_confidence_verdict, "
            " developer_confidence_signals, developer_confidence_reasoning) "
            "VALUES (?, ?, ?, ?, ?,  ?, ?,  ?, ?,  ?, ?,  ?, ?,  ?, ?,  ?, ?, "
            "        ?, ?,  ?, ?, ?,  ?, ?, ?, ?)",
            (
                session_id, tags_passed, tests_total, traps_detected, traps_total,
                llm_dims["code_quality"]["score"],
                json.dumps(llm_dims["code_quality"]["breakdown"]),
                llm_dims["architectural_reasoning"]["score"],
                json.dumps(llm_dims["architectural_reasoning"]["breakdown"]),
                llm_dims["llm_communication"]["score"],
                json.dumps(llm_dims["llm_communication"]["breakdown"]),
                vd["score"], json.dumps(vd["breakdown"]),
                aj["score"], json.dumps(aj["breakdown"]),
                cs["score"], json.dumps(cs["breakdown"]),
                json.dumps(attribution),
                json.dumps(composite_breakdown),
                round(total_score, 2),
                grader_summary,
                raw_output[:50_000],
                dev_conf["score"], dev_conf["verdict"],
                json.dumps(dev_conf["signals"]) if dev_conf["signals"] is not None else None,
                dev_conf["reasoning"],
            ),
        )
        execute("UPDATE sessions SET status='graded' WHERE id=?", (session_id,))
        log.info(
            "grading_completed",
            extra={"context": {
                "session_id": session_id,
                "duration_s": round(time.time() - started, 2),
                "total_score": round(total_score, 2),
                "tests_passed": tags_passed,
                "tests_total": tests_total,
            }},
        )
    finally:
        if clone_dir.exists():
            shutil.rmtree(clone_dir)


def _composite(dim_scores: dict[str, float]) -> tuple[float, dict[str, Any]]:
    """Weighted sum across the 8 rubric dimensions. Returns (score, breakdown)."""
    if abs(sum(COMPOSITE_WEIGHTS.values()) - 1.0) > 1e-9:
        raise ValueError("COMPOSITE_WEIGHTS must sum to 1.0")
    contributions = {}
    total = 0.0
    for k, w in COMPOSITE_WEIGHTS.items():
        s = float(dim_scores.get(k, 0.0))
        contrib = s * w
        contributions[k] = {
            "raw_score": round(s, 2),
            "weight": w,
            "weighted_contribution": round(contrib, 3),
        }
        total += contrib
    return total, {"dimensions": contributions, "weights": COMPOSITE_WEIGHTS,
                   "total": round(total, 2)}


# ─── Summary builder ──────────────────────────────────────────────────────────

# UI splits on ' | ' and parses each line as `Label (X/10): reasoning`
# (server/static/app.js: parseSummaryLine). Reasonings must not contain ' | '
# or ': ' at the start, so we sanitise.
_SUMMARY_SEP = " | "

_SUMMARY_LABELS = {
    "tests":                   "Tests",
    "traps":                   "Traps",
    "verification_discipline": "Verification discipline",
    "ai_judgment":             "AI judgment",
    "code_quality":            "Code quality",
    "llm_communication":       "LLM communication",
    "architectural_reasoning": "Architectural reasoning",
    "challenge_specific":      "Challenge-specific",
}


def _build_summary(
    dim_scores: dict[str, float],
    *,
    tests_passed: int, tests_total: int,
    traps_detected: int, traps_total: int,
    llm_dims: dict[str, Any],
    vd: dict[str, Any], aj: dict[str, Any], cs: dict[str, Any],
) -> str:
    reasonings = {
        "tests": _tests_reason(tests_passed, tests_total),
        "traps": _traps_reason(traps_detected, traps_total),
        "verification_discipline": _signals_reason(vd.get("breakdown", {})),
        "ai_judgment":             _signals_reason(aj.get("breakdown", {})),
        "code_quality":            _criteria_reason(llm_dims.get("code_quality", {}).get("breakdown", {})),
        "llm_communication":       _criteria_reason(llm_dims.get("llm_communication", {}).get("breakdown", {})),
        "architectural_reasoning": _criteria_reason(llm_dims.get("architectural_reasoning", {}).get("breakdown", {})),
        "challenge_specific":      _challenge_specific_reason(cs.get("breakdown", {})),
    }
    parts = []
    for key in COMPOSITE_WEIGHTS:  # preserve rubric ordering
        score = float(dim_scores.get(key, 0.0))
        score_str = f"{score:.1f}".rstrip("0").rstrip(".") or "0"
        label = _SUMMARY_LABELS.get(key, key)
        reason = _sanitise(reasonings.get(key) or "no reasoning recorded")
        parts.append(f"{label} ({score_str}/10): {reason}")
    return _SUMMARY_SEP.join(parts)


def _tests_reason(passed: int, total: int) -> str:
    if not total:
        return "no hidden tests configured (build may have failed)"
    return f"{passed} of {total} hidden test tags passed"


def _traps_reason(detected: int, total: int) -> str:
    if not total:
        return "no planted traps for this challenge"
    return f"{detected} of {total} planted traps caught"


def _criteria_reason(breakdown: dict[str, Any]) -> str:
    """One-line reasoning for the LLM-graded dims.

    Picks the lowest-scoring criterion (most actionable signal) and surfaces its
    1-line reasoning. Falls back to breakdown['reason'] if no criteria block."""
    criteria = breakdown.get("criteria") if isinstance(breakdown, dict) else None
    if not isinstance(criteria, dict) or not criteria:
        reason = breakdown.get("reason") if isinstance(breakdown, dict) else None
        return reason or "no per-criterion detail available"
    weakest_key, weakest = min(
        criteria.items(),
        key=lambda kv: (kv[1] or {}).get("score", 10) if isinstance(kv[1], dict) else 10,
    )
    if not isinstance(weakest, dict):
        return "no per-criterion detail available"
    reasoning = (weakest.get("reasoning") or "").strip()
    if reasoning:
        return f"weakest criterion '{weakest_key}' ({weakest.get('score', '?')}/10): {reasoning}"
    return f"weakest criterion: '{weakest_key}' at {weakest.get('score', '?')}/10"


def _signals_reason(breakdown: dict[str, Any]) -> str:
    """One-line reasoning for vd/aj (telemetry-derived) dimensions."""
    if not isinstance(breakdown, dict):
        return "no signal detail available"
    signals = breakdown.get("signals")
    if isinstance(signals, dict) and signals:
        scored = [(k, v) for k, v in signals.items()
                  if isinstance(v, dict) and isinstance(v.get("score"), (int, float))]
        if scored:
            weakest_key, weakest = min(scored, key=lambda kv: kv[1]["score"])
            reason = (weakest.get("reason") or "").strip()
            extras = []
            for fld in ("ratio", "rate", "count", "applies"):
                if fld in weakest and weakest[fld] is not None:
                    extras.append(f"{fld}={weakest[fld]}")
            extras_str = f" ({', '.join(extras)})" if extras else ""
            tail = f": {reason}" if reason else ""
            return f"weakest signal '{weakest_key}' {weakest['score']}/10{extras_str}{tail}"
    return breakdown.get("reason") or "no signal detail available"


def _challenge_specific_reason(breakdown: dict[str, Any]) -> str:
    if not isinstance(breakdown, dict):
        return "no detail available"
    if breakdown.get("reason"):
        return breakdown["reason"]
    criteria = breakdown.get("criteria")
    if isinstance(criteria, dict) and criteria:
        weakest_key, weakest = min(
            criteria.items(),
            key=lambda kv: (kv[1] or {}).get("score", 10) if isinstance(kv[1], dict) else 10,
        )
        if isinstance(weakest, dict):
            reason = (weakest.get("reason") or "").strip()
            tail = f": {reason}" if reason else ""
            return f"weakest criterion '{weakest_key}' {weakest.get('score', '?')}/10{tail}"
    return "no detail available"


def _sanitise(text: str) -> str:
    """Strip separators that would confuse the UI parser."""
    if not isinstance(text, str):
        return ""
    cleaned = text.replace("\n", " ").replace("\r", " ")
    cleaned = cleaned.replace(_SUMMARY_SEP, " / ")
    return cleaned.strip()


def _llm_fallback() -> dict[str, Any]:
    fb = {"score": _FALLBACK, "breakdown": {"reason": "LLM grading failed — fallback"}}
    return {
        "code_quality": fb,
        "architectural_reasoning": fb,
        "llm_communication": fb,
        "summary": "AI grading failed — partial results only.",
    }


def _record_error(session_id: str, stage: str) -> None:
    # log.exception() captures the active exception via sys.exc_info(), so
    # the traceback lands in the JSON log stream automatically — alongside
    # the structured grading_errors row, which is what the recruiter
    # dashboard renders.
    log.exception(
        "grading_stage_failed",
        extra={"context": {"session_id": session_id, "stage": stage}},
    )
    execute(
        "INSERT INTO grading_errors (session_id, ts, user_message, stage, error_class, traceback) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (
            session_id,
            int(time.time() * 1000),
            _STAGE_MESSAGES.get(stage, "An error occurred during grading."),
            stage,
            "",
            tb_module.format_exc(),
        ),
    )
