import json
import os
import tempfile
from unittest.mock import MagicMock

import pytest

_db_fd, _db_path = tempfile.mkstemp(suffix=".db")
os.environ.setdefault("OPENAI_API_KEY", "sk-test")
os.environ.setdefault("GITHUB_BOT_PAT", "ghp-test")
os.environ["GITHUB_CHALLENGES_OWNER"] = ""
os.environ.setdefault("GITHUB_CHALLENGES_REPO", "test-org/test-repo")
os.environ.setdefault("ADMIN_TOKEN", "admin-secret")
os.environ.setdefault("DB_PATH", _db_path)
os.environ.setdefault("LLM_BASE_URL", "https://openrouter.ai/api/v1")

from vibe.db import bootstrap, execute, query  # noqa: E402
from vibe.grader import llm_eval  # noqa: E402

bootstrap()


@pytest.fixture(autouse=True)
def _clean():
    for tbl in ("grading_errors", "grades", "jobs", "chat_exchanges", "telemetry", "sessions"):
        execute(f"DELETE FROM {tbl}")
    yield


def _seed_session(sid: str) -> None:
    execute(
        "INSERT INTO sessions (id, session_key, candidate_email, challenge_id, branch_name, status) "
        "VALUES (?, ?, 'c@test.com', 'cpp-lru-cache', ?, 'active')",
        (sid, f"KEY-{sid}", f"interview/{sid}"),
    )


def _make_resp(content: str) -> MagicMock:
    resp = MagicMock()
    resp.choices[0].message.content = content
    return resp


def test_retry_on_bad_json_succeeds_on_second_call():
    """First call returns broken JSON; second call (retry) returns valid JSON."""
    sid = "retry-001"
    _seed_session(sid)

    mock_client = MagicMock()
    mock_client.chat.completions.create.side_effect = [
        _make_resp("not valid json {{{{"),
        _make_resp(json.dumps({"analysis": "good code", "score": 8, "confidence": 0.9})),
    ]

    result = llm_eval._single_llm_call(
        mock_client, "grade this", 0.0, "fallback", sid, "llm_eval.code_quality"
    )

    assert result is not None
    assert result["score"] == 8
    assert mock_client.chat.completions.create.call_count == 2


def test_retry_records_grading_error_for_parse_failure():
    """A grading_errors row is written for the parse_retry stage."""
    sid = "retry-002"
    _seed_session(sid)

    mock_client = MagicMock()
    mock_client.chat.completions.create.side_effect = [
        _make_resp("broken json }{"),
        _make_resp(json.dumps({"analysis": "ok", "score": 6, "confidence": 0.7})),
    ]

    llm_eval._single_llm_call(
        mock_client, "grade this", 0.0, "fallback reason", sid, "llm_eval.code_quality"
    )

    errors = query("SELECT stage FROM grading_errors WHERE session_id=?", (sid,))
    assert any("parse_retry" in e["stage"] for e in errors)


def test_both_calls_fail_returns_none():
    """If both attempts fail JSON parse, returns None (caller uses fallback score)."""
    sid = "retry-003"
    _seed_session(sid)

    mock_client = MagicMock()
    mock_client.chat.completions.create.side_effect = [
        _make_resp("bad json 1"),
        _make_resp("bad json 2"),
    ]

    result = llm_eval._single_llm_call(
        mock_client, "grade this", 0.0, "fallback", sid, "llm_eval.code_quality"
    )

    assert result is None


def test_non_json_exception_returns_none_immediately():
    """An API error (not JSON parse) returns None without retrying."""
    sid = "retry-004"
    _seed_session(sid)

    mock_client = MagicMock()
    mock_client.chat.completions.create.side_effect = RuntimeError("API down")

    result = llm_eval._single_llm_call(
        mock_client, "grade this", 0.0, "fallback", sid, "llm_eval.code_quality"
    )

    assert result is None
    assert mock_client.chat.completions.create.call_count == 1

    errors = query("SELECT stage, error_class FROM grading_errors WHERE session_id=?", (sid,))
    assert len(errors) == 1
    assert errors[0]["error_class"] == "RuntimeError"
    assert errors[0]["stage"] == "llm_eval.code_quality"


def test_coerce_score_handles_int_float_string():
    assert llm_eval._coerce_score(7) == 7
    assert llm_eval._coerce_score(7.4) == 7
    assert llm_eval._coerce_score(7.6) == 8
    assert llm_eval._coerce_score("8") == 8
    assert llm_eval._coerce_score("7.5") == 8  # rounds half-to-even, 7.5 → 8


def test_coerce_score_clamps_out_of_bounds():
    assert llm_eval._coerce_score(0) == 1
    assert llm_eval._coerce_score(-5) == 1
    assert llm_eval._coerce_score(15) == 10
    assert llm_eval._coerce_score(100) == 10


def test_coerce_score_rejects_invalid():
    import pytest as _pt
    with _pt.raises(ValueError):
        llm_eval._coerce_score(True)
    with _pt.raises((ValueError, TypeError)):
        llm_eval._coerce_score("not a number")


def test_float_score_in_llm_response_works():
    """Whole flow: LLM returns score as float, _single_llm_call coerces correctly."""
    sid = "retry-005"
    _seed_session(sid)

    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _make_resp(
        json.dumps({"analysis": "good", "score": 7.6, "confidence": 0.9})
    )

    result = llm_eval._single_llm_call(
        mock_client, "grade this", 0.0, "fallback", sid, "llm_eval.code_quality"
    )

    assert result is not None
    assert result["score"] == 8
