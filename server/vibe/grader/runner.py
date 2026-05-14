import json
import shutil
import time
import traceback as tb_module
from pathlib import Path
from vibe.config import repo_for_challenge, settings
from vibe.db import execute, query
from vibe.grader import cpp_runner, python_runner, llm_eval, traps as traps_module
from vibe.grader.git_ops import clone_branch

_STAGE_MESSAGES = {
    "clone": "We could not access your submission repository. Please contact support.",
    "build": "We could not build your submission. Please contact support.",
    "traps": "An error occurred during trap evaluation. Please contact support.",
    "llm_eval": "AI grading is temporarily unavailable. Please contact support.",
    "repo_tokens": "Token counting failed during grading. Please contact support.",
}

_GRADER_BACKENDS = {"cpp": cpp_runner, "python": python_runner}


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

    clone_dir = Path(f"/tmp/grade-{session_id}")
    if clone_dir.exists():
        shutil.rmtree(clone_dir)

    try:
        try:
            clone_branch(repo_for_challenge(session["challenge_id"]), session["branch_name"], clone_dir)
        except Exception:
            _record_error(session_id, "clone")
            execute("UPDATE sessions SET status='grading_failed' WHERE id=?", (session_id,))
            return

        challenge_dir = Path(settings.challenges_dir) / session["challenge_id"]

        try:
            metadata, rubric, tags = _load_challenge_config(challenge_dir)
            hidden_test = challenge_dir / metadata["hidden_test_file"]
            backend = _GRADER_BACKENDS[metadata["grader"]]
            tag_results, raw_output = backend.build_and_test(clone_dir, hidden_test, tags)
        except Exception:
            _record_error(session_id, "build")
            tag_results, raw_output = {}, ""
            rubric = {}
        weights = rubric.get("composite_weights", {})

        try:
            traps_detected, traps_total, detected_traps, missed_traps, traps_detected_w, traps_total_w = traps_module.evaluate_traps(challenge_dir, tag_results)
        except Exception:
            _record_error(session_id, "traps")
            traps_detected, traps_total, detected_traps, missed_traps, traps_detected_w, traps_total_w = 0, 0, [], [], 0, 0

        try:
            llm_scores = llm_eval.evaluate(session_id, session["challenge_id"], tag_results, clone_dir, detected_traps, missed_traps)
        except Exception:
            _record_error(session_id, "llm_eval")
            llm_scores = {
                "code_quality_score": _FALLBACK,
                "ai_orchestration_score": _FALLBACK,
                "architectural_reasoning_score": _FALLBACK,
                "prompt_quality_score": _FALLBACK,
                "token_efficiency_score": _FALLBACK,
                "summary": "AI grading failed — partial results only.",
            }

        tags_passed = sum(1 for v in tag_results.values() if v)
        tests_total = len(tag_results)

        total_score = _composite_score(
            tags_passed, tests_total, traps_detected_w, traps_total_w, llm_scores, weights
        )

        execute(
            "INSERT OR REPLACE INTO grades "
            "(session_id, tests_passed, tests_total, traps_detected, traps_total, "
            "code_quality_score, ai_orchestration_score, architectural_reasoning_score, "
            "prompt_quality_score, token_efficiency_score, "
            "total_score, grader_summary, raw_output) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                session_id, tags_passed, tests_total,
                traps_detected, traps_total,
                llm_scores["code_quality_score"],
                llm_scores["ai_orchestration_score"],
                llm_scores["architectural_reasoning_score"],
                llm_scores["prompt_quality_score"],
                llm_scores["token_efficiency_score"],
                round(total_score, 2),
                llm_scores["summary"],
                raw_output[:50_000],
            ),
        )
        execute("UPDATE sessions SET status='graded' WHERE id=?", (session_id,))
    finally:
        if clone_dir.exists():
            shutil.rmtree(clone_dir)


_FALLBACK = 5


def _record_error(session_id: str, stage: str) -> None:
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


_DEFAULT_WEIGHTS = {
    "test_score": 0.20,
    "trap_score": 0.10,
    "code_quality": 0.20,
    "ai_orchestration": 0.15,
    "architectural_reasoning": 0.10,
    "prompt_quality": 0.15,
    "token_efficiency": 0.10,
}


def _composite_score(
    tests_passed: int,
    tests_total: int,
    traps_detected_w: int,
    traps_total_w: int,
    llm_scores: dict,
    weights: dict,
) -> float:
    w = {**_DEFAULT_WEIGHTS, **weights}
    test_score = (tests_passed / tests_total * 10) if tests_total else 0
    trap_score = (traps_detected_w / traps_total_w * 10) if traps_total_w else 0
    automated = test_score * w["test_score"] + trap_score * w["trap_score"]
    llm = (
        llm_scores["code_quality_score"] * w["code_quality"]
        + llm_scores["ai_orchestration_score"] * w["ai_orchestration"]
        + llm_scores["architectural_reasoning_score"] * w["architectural_reasoning"]
        + llm_scores["prompt_quality_score"] * w["prompt_quality"]
        + llm_scores["token_efficiency_score"] * w["token_efficiency"]
    )
    return automated + llm
