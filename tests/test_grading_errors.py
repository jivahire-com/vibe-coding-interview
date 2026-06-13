import os
import tempfile
from unittest.mock import patch

import pytest

_db_fd, _db_path = tempfile.mkstemp(suffix=".db")
os.environ.update({
    "OPENAI_API_KEY": "sk-test",
    "GITHUB_BOT_PAT": "ghp-test",
    "GITHUB_CHALLENGES_REPO": "test-org/test-repo",
    "GITHUB_CHALLENGES_OWNER": "",
    "ADMIN_TOKEN": "admin-secret",
    "DB_PATH": _db_path,
    "LLM_BASE_URL": "https://openrouter.ai/api/v1",
})

from vibe.db import bootstrap, execute, query  # noqa: E402
from vibe.grader import runner  # noqa: E402

bootstrap()


@pytest.fixture(autouse=True)
def _clean():
    for tbl in ("grading_errors", "grades", "jobs", "chat_exchanges", "telemetry", "sessions"):
        execute(f"DELETE FROM {tbl}")
    yield


def _seed_session(sid: str) -> str:
    execute(
        "INSERT INTO sessions (id, session_key, candidate_email, challenge_id, branch_name, status) "
        "VALUES (?, ?, 'c@test.com', 'cpp-thread-safe-cache', ?, 'submitted')",
        (sid, f"KEY-{sid}", f"interview/{sid}"),
    )
    return sid


def test_clone_failure_records_grading_error():
    sid = _seed_session("s-err-001")

    with patch("vibe.grader.runner.clone_branch", side_effect=RuntimeError("network error")):
        runner.run(sid)

    errors = query("SELECT stage, user_message, traceback FROM grading_errors WHERE session_id=?", (sid,))
    assert len(errors) == 1
    assert errors[0]["stage"] == "clone"
    assert errors[0]["user_message"] != ""
    assert "RuntimeError" in errors[0]["traceback"]

    session = query("SELECT status FROM sessions WHERE id=?", (sid,))[0]
    assert session["status"] == "grading_failed"


def test_llm_eval_failure_records_grading_error():
    sid = _seed_session("s-err-002")

    def fail_eval(*_a, **_kw):
        raise RuntimeError("openai down")

    with (
        patch("vibe.grader.runner.clone_branch"),
        patch("vibe.grader.runner.cpp_runner.build_and_test", return_value=({}, "")),
        patch("vibe.grader.runner.traps_module.evaluate_traps", return_value=(0, 0, [], [], 0, 0)),
        patch("vibe.grader.runner.llm_eval.evaluate", side_effect=fail_eval),
    ):
        runner.run(sid)

    errors = query("SELECT stage, traceback FROM grading_errors WHERE session_id=?", (sid,))
    assert any(e["stage"] == "llm_eval" for e in errors)
    assert any("RuntimeError" in e["traceback"] for e in errors)
