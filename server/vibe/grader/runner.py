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
                llm_dims.get("summary", ""),
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
