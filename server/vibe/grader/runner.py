"""
Grading runner — orchestrates the full pipeline for a submitted session.

Pipeline (GRADING_METRICS_MAP.md three-layer contract):
  1. clone the candidate's branch
  2. ingest the telemetry JSONL into the `telemetry` table
  3. build + run the hidden test suite (per-tag pass/fail)
  4. trap detection + attribution
  5. build Layer-2 SIGNALS once (every derivation, both tracks)
  6. run the Layer-3 RUBRICS as pure consumers of signals
  7. engagement / telemetry-integrity gates (floor scores)
  8. assemble the single 0-100 REPORT (×10 once, weighted average) and persist

There is no composite math here: report.build_report owns the ×10 conversion and
the weight-weighted total. The runner keeps orchestration, the gates, and
persistence.
"""

from __future__ import annotations

import json
import logging
import shutil
import sys
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
    engagement as engagement_mod,
    llm_eval,
    python_runner,
    report as report_mod,
    signals as signals_mod,
    trap_attribution,
    telemetry_integrity,
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
    "signals": "Telemetry signal computation failed; some scoring may use partial data.",
    "llm_eval": "AI grading is temporarily unavailable. Please contact support.",
    "verification_discipline": "Verification-discipline scoring failed; grade unaffected.",
    "ai_judgment": "AI-judgment scoring failed; grade unaffected.",
    "developer_signal": "Developer-signal scoring failed; grade unaffected.",
    "challenge_specific": "Challenge-specific scoring failed; grade unaffected.",
    "engagement": "Engagement assessment failed; scores left unfloored.",
    "telemetry_ingest": "Could not read telemetry from your submission; some scoring may use partial data.",
    "telemetry_integrity": "Telemetry integrity check failed; grade is unaffected.",
    "report": "Report assembly failed. Please contact support.",
}

_GRADER_BACKENDS = {"cpp": cpp_runner, "python": python_runner, "typescript": typescript_runner}

# Dimensions floored on a no-show (objective tests/traps are NOT floored here).
_NON_OBJECTIVE = (
    "verification_discipline", "ai_judgment", "challenge_specific",
    "code_quality", "architectural_reasoning", "llm_communication", "developer_signal",
)
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
    ai_assistance = bool(session.get("ai_assistance", 1))
    track = "vibe" if ai_assistance else "non_ai"
    started = time.time()
    log.info("grading_started", extra={"context": {
        "session_id": session_id, "challenge_id": session["challenge_id"],
        "ai_assistance": ai_assistance}})

    clone_dir = Path(f"/tmp/grade-{session_id}")
    if clone_dir.exists():
        shutil.rmtree(clone_dir)

    try:
        # ── 1. Clone ──────────────────────────────────────────────────────
        try:
            clone_branch(repo_for_challenge(session["challenge_id"]), session["branch_name"], clone_dir)
        except Exception:
            _record_error(session_id, "clone")
            execute("UPDATE sessions SET status='grading_failed' WHERE id=?", (session_id,))
            return

        # ── 2. Ingest telemetry ───────────────────────────────────────────
        try:
            _telemetry_ingest.ingest(session_id, clone_dir)
        except Exception:
            _record_error(session_id, "telemetry_ingest")

        challenge_dir = Path(settings.challenges_dir) / session["challenge_id"]

        # ── 3. Build + run hidden tests ───────────────────────────────────
        # Every backend returns an EMPTY tag_results when the project fails to
        # build/compile (and a populated one — pass or fail per tag — otherwise).
        # So "tags were expected but none ran" is the build-failure signal.
        tags: list[str] = []
        try:
            metadata, rubric, tags = _load_challenge_config(challenge_dir)
            hidden_test = challenge_dir / metadata["hidden_test_file"]
            backend = _GRADER_BACKENDS[metadata["grader"]]
            tag_results, raw_output = backend.build_and_test(clone_dir, hidden_test, tags)
            build_failed = bool(tags) and not tag_results
        except Exception:
            _record_error(session_id, "build")
            tag_results, raw_output, rubric, build_failed = {}, "", {}, True

        # ── 4. Traps + attribution ────────────────────────────────────────
        try:
            (traps_detected, traps_total, detected_traps, missed_traps,
             traps_detected_w, traps_total_w) = traps_module.evaluate_traps(challenge_dir, tag_results)
        except Exception:
            _record_error(session_id, "traps")
            traps_detected, traps_total, detected_traps, missed_traps, traps_detected_w, traps_total_w = \
                0, 0, [], [], 0, 0
        try:
            attribution = trap_attribution.classify(session_id, detected_traps)
        except Exception:
            _record_error(session_id, "attribution")
            attribution = {"attributions": {}, "session_signals": {}}

        client = OpenAI(api_key=settings.openai_api_key, base_url=settings.llm_base_url)

        # ── 5. SIGNALS (Layer 2) — computed once ──────────────────────────
        try:
            signals = signals_mod.build(
                session_id, ai_assistance=ai_assistance,
                submitted_at_s=session.get("submitted_at"),
                attribution=attribution, clone_dir=clone_dir, client=client,
            )
        except Exception:
            _record_error(session_id, "signals")
            signals = signals_mod.Signals(ai_assistance=ai_assistance)

        # ── 6. RUBRICS (Layer 3) — pure consumers ─────────────────────────
        dims: dict[str, dict[str, Any]] = {}
        dims["tests"] = _tests_rubric(tag_results, build_failed, tags)
        dims["traps"] = _traps_rubric(detected_traps, missed_traps, traps_detected_w, traps_total_w)

        try:
            llm_dims = llm_eval.evaluate(session_id, session["challenge_id"], tag_results, clone_dir,
                                         detected_traps, missed_traps, signals, ai_assistance=ai_assistance)
        except Exception:
            _record_error(session_id, "llm_eval")
            llm_dims = {k: {"score": _FALLBACK, "subpoints": [], "note": "LLM grading failed"}
                        for k in ("code_quality", "architectural_reasoning", "llm_communication")}
        dims["code_quality"] = llm_dims["code_quality"]
        dims["architectural_reasoning"] = llm_dims["architectural_reasoning"]
        dims["llm_communication"] = llm_dims["llm_communication"]

        try:
            dims["verification_discipline"] = verification_discipline.score(signals)
        except Exception:
            _record_error(session_id, "verification_discipline")
            dims["verification_discipline"] = {"score": _FALLBACK, "subpoints": [], "note": "failed"}

        if ai_assistance:
            try:
                dims["ai_judgment"] = ai_judgment.score(signals)
            except Exception:
                _record_error(session_id, "ai_judgment")
                dims["ai_judgment"] = {"score": _FALLBACK, "subpoints": [], "note": "failed"}
        else:
            dims["ai_judgment"] = {"score": None, "subpoints": []}

        try:
            dims["developer_signal"] = developer_signals.score(signals, client, session_id)
        except Exception:
            _record_error(session_id, "developer_signal")
            dims["developer_signal"] = {"score": _FALLBACK, "subpoints": [], "note": "failed"}

        try:
            dims["challenge_specific"] = challenge_specific.score(session["challenge_id"], clone_dir, rubric)
        except Exception:
            _record_error(session_id, "challenge_specific")
            dims["challenge_specific"] = {"score": _FALLBACK, "subpoints": [], "note": "failed"}

        # ── 6.5. Bonuses (lift, never penalise) ───────────────────────────
        bonuses: list[dict[str, Any]] = [developer_signals.debugger_bonus(signals)]
        try:
            ps = challenge_specific.product_sense_bonus(clone_dir, rubric, getattr(signals, "design_why", None))
            bonuses.append(ps["card"])
            if ps["boost"] and dims["architectural_reasoning"].get("score") is not None:
                ar = dims["architectural_reasoning"]
                ar["score"] = round(min(10.0, ar["score"] + ps["boost"]), 2)
        except Exception:
            _record_error(session_id, "challenge_specific")

        # ── 7. Gates ──────────────────────────────────────────────────────
        try:
            engagement = engagement_mod.assess(session_id, clone_dir)
        except Exception:
            _record_error(session_id, "engagement")
            engagement = {"attended": True, "reason": None, "signals": {}}
        if not engagement["attended"]:
            _floor_dims(dims, _NON_OBJECTIVE, engagement["reason"], key="no_show")

        try:
            integrity = telemetry_integrity.check(session_id, clone_dir)
        except Exception:
            _record_error(session_id, "telemetry_integrity")
            integrity = {"tampered": False, "verdict": "error", "detail": ""}
        telemetry_tampered = bool(integrity.get("tampered"))
        if telemetry_tampered:
            note = "Telemetry integrity violation: " + (
                integrity.get("detail") or "the telemetry record was deleted or tampered with.")
            _floor_dims(dims, list(dims.keys()), note, key="telemetry_tampered")

        # ── 8. Report (Layer 3 assembly) + persist ────────────────────────
        try:
            commits = _count_commits(session_id)
            protected = _count_protected_edits(session_id)
            report = report_mod.build_report(
                track, dims, signals,
                meta={"challenge": session["challenge_id"],
                      "candidate": session.get("candidate_email") or "",
                      "ai_assistance": ai_assistance,
                      "no_show": not engagement["attended"],
                      "telemetry_tampered": telemetry_tampered,
                      "build_failed": build_failed,
                      "build_error": _build_error_excerpt(raw_output) if build_failed else ""},
                bonuses=bonuses,
                telemetry_extra={"commits": commits, "protected_file_edits": protected},
            )
        except Exception:
            _record_error(session_id, "report")
            execute("UPDATE sessions SET status='grading_failed' WHERE id=?", (session_id,))
            return

        total_score = report["overall"]["score"]
        band = report["overall"]["band"]
        tags_passed = sum(1 for v in tag_results.values() if v)

        execute(
            "INSERT OR REPLACE INTO grades "
            "(session_id, track, total_score, band, report_json, raw_output) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (session_id, track, total_score, band, json.dumps(report), raw_output[:50_000]),
        )
        execute("UPDATE sessions SET status='graded' WHERE id=?", (session_id,))
        log.info("grading_completed", extra={"context": {
            "session_id": session_id, "duration_s": round(time.time() - started, 2),
            "total_score": total_score, "band": band,
            "tests_passed": tags_passed, "tests_total": len(tag_results)}})
    finally:
        if clone_dir.exists():
            shutil.rmtree(clone_dir)


# ─── Deterministic rubrics (tests, traps) ────────────────────────────────────


def _tests_rubric(tag_results: dict[str, bool], build_failed: bool = False,
                  tags: list[str] | None = None) -> dict[str, Any]:
    total = len(tag_results)
    passed = sum(1 for v in tag_results.values() if v)
    score = (passed / total * 10) if total else 0.0
    if build_failed:
        # The code never compiled, so no test ran. List every expected tag as
        # "not run" so the report is explicit instead of looking like an empty
        # rubric, and say plainly that the build failed.
        subs = [
            {"key": tag, "checks": f"The '{tag}' hidden test tag passes.",
             "verdict": "missing", "detail": "Not run — your code did not compile."}
            for tag in sorted(tags or [])
        ]
        note = ("Your code did not compile, so the hidden test suite could not be built — "
                "every test scored 0. See the build log for the compiler errors.")
        return {"score": 0.0, "subpoints": subs, "note": note}
    subs = [
        {"key": tag, "checks": f"The '{tag}' hidden test tag passes.",
         "verdict": "strong" if ok else "missing",
         "detail": "Passed." if ok else "Failed."}
        for tag, ok in sorted(tag_results.items())
    ]
    note = None if total else "No hidden tests configured (build may have failed)."
    return {"score": round(score, 2), "subpoints": subs, "note": note}


def _build_error_excerpt(raw_output: str, limit: int = 2000) -> str:
    """Tail of the build log — the part holding the compiler errors — for the UI."""
    if not raw_output:
        return ""
    return raw_output[-limit:].strip()


def _traps_rubric(detected, missed, detected_w, total_w) -> dict[str, Any]:
    score = (detected_w / total_w * 10) if total_w else 0.0
    subs = []
    for t in detected:
        subs.append({"key": t.get("id", "trap"), "checks": t.get("description", ""),
                     "verdict": "strong", "detail": "Caught and fixed."})
    for t in missed:
        subs.append({"key": t.get("id", "trap"), "checks": t.get("description", ""),
                     "verdict": "missing", "detail": "Left in the code."})
    note = None if (detected or missed) else "No planted traps for this challenge."
    return {"score": round(score, 2), "subpoints": subs, "note": note}


# ─── Gates ───────────────────────────────────────────────────────────────────


def _floor_dims(dims: dict[str, dict[str, Any]], keys, reason: str, *, key: str) -> None:
    for k in keys:
        dim = dims.get(k)
        if not dim or dim.get("score") is None:
            continue
        dim["score"] = min(float(dim["score"]), engagement_mod.NEAR_ZERO)
        dim["note"] = reason
        dim[key] = True


def _count_commits(session_id: str) -> int:
    rows = query("SELECT COUNT(*) AS c FROM telemetry WHERE session_id=? AND event_type='auto_commit'",
                 (session_id,))
    return rows[0]["c"] if rows else 0


def _count_protected_edits(session_id: str) -> int:
    rows = query("SELECT COUNT(*) AS c FROM telemetry WHERE session_id=? AND event_type='protected_file_edit'",
                 (session_id,))
    return rows[0]["c"] if rows else 0


def _record_error(session_id: str, stage: str) -> None:
    log.exception("grading_stage_failed", extra={"context": {"session_id": session_id, "stage": stage}})
    exc_type = sys.exc_info()[0]
    error_class = exc_type.__name__ if exc_type else ""
    execute(
        "INSERT INTO grading_errors (session_id, ts, user_message, stage, error_class, traceback) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (session_id, int(time.time() * 1000), _STAGE_MESSAGES.get(stage, "An error occurred during grading."),
         stage, error_class, tb_module.format_exc()),
    )
