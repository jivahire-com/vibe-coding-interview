import shutil
import time
from pathlib import Path
from vibe.config import settings
from vibe.db import execute, query
from vibe.grader import cpp_runner, llm_eval, traps as traps_module
from vibe.grader.git_ops import clone_branch


def run(session_id: str) -> None:
    rows = query("SELECT * FROM sessions WHERE id=?", (session_id,))
    if not rows:
        raise ValueError(f"Session {session_id} not found")
    session = rows[0]

    clone_dir = Path(f"/tmp/grade-{session_id}")
    if clone_dir.exists():
        shutil.rmtree(clone_dir)

    try:
        clone_branch(settings.github_challenges_repo, session["branch_name"], clone_dir)

        challenge_dir = Path(settings.challenges_dir) / session["challenge_id"]
        hidden_test = challenge_dir / "tests" / "hidden_test.cpp"
        tag_results, raw_output = cpp_runner.build_and_test(clone_dir, hidden_test)

        traps_detected, traps_total = traps_module.evaluate_traps(challenge_dir, tag_results)

        tags_passed = sum(1 for v in tag_results.values() if v)
        tests_total = len(tag_results)

        llm_scores = llm_eval.evaluate(session_id, session["challenge_id"], tag_results, clone_dir)

        total_score = _composite_score(
            tags_passed, tests_total, traps_detected, traps_total, llm_scores
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


def _composite_score(
    tests_passed: int,
    tests_total: int,
    traps_detected: int,
    traps_total: int,
    llm_scores: dict,
) -> float:
    test_score = (tests_passed / tests_total * 10) if tests_total else 0
    trap_score = (traps_detected / traps_total * 10) if traps_total else 0
    automated = test_score * 0.20 + trap_score * 0.10
    llm = (
        llm_scores["code_quality_score"] * 0.20
        + llm_scores["ai_orchestration_score"] * 0.15
        + llm_scores["architectural_reasoning_score"] * 0.10
        + llm_scores["prompt_quality_score"] * 0.15
        + llm_scores["token_efficiency_score"] * 0.10
    )
    return automated + llm
