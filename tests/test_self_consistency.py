import json
import os
import tempfile
from unittest.mock import MagicMock, patch

import pytest

_db_fd, _db_path = tempfile.mkstemp(suffix=".db")
os.environ.setdefault("OPENAI_API_KEY", "sk-test")
os.environ.setdefault("GITHUB_BOT_PAT", "ghp-test")
os.environ["GITHUB_CHALLENGES_OWNER"] = ""
os.environ.setdefault("GITHUB_CHALLENGES_REPO", "test-org/test-repo")
os.environ.setdefault("ADMIN_TOKEN", "admin-secret")
os.environ.setdefault("DB_PATH", _db_path)
os.environ.setdefault("LLM_BASE_URL", "https://openrouter.ai/api/v1")

from vibe.db import bootstrap, execute  # noqa: E402
from vibe.grader import llm_eval  # noqa: E402
from vibe.config import settings  # noqa: E402

bootstrap()


@pytest.fixture(autouse=True)
def _clean():
    for tbl in ("grading_errors", "grades", "jobs", "chat_exchanges", "telemetry", "sessions"):
        execute(f"DELETE FROM {tbl}")
    orig = settings.grader_self_consistency_n
    yield
    settings.grader_self_consistency_n = orig


def _make_mock_client_with_scores(scores: list[int]) -> MagicMock:
    mock_client = MagicMock()
    responses = []
    for s in scores:
        resp = MagicMock()
        resp.choices[0].message.content = json.dumps({"analysis": f"run score {s}", "score": s, "confidence": 0.8})
        responses.append(resp)
    mock_client.chat.completions.create.side_effect = responses
    return mock_client


def test_n1_makes_one_call():
    settings.grader_self_consistency_n = 1
    mock_client = _make_mock_client_with_scores([7])

    result = llm_eval._call(mock_client, "prompt", "fallback", use_sc=True)

    assert mock_client.chat.completions.create.call_count == 1
    assert result["score"] == 7


def test_n3_returns_median_score():
    settings.grader_self_consistency_n = 3
    mock_client = _make_mock_client_with_scores([5, 9, 7])

    result = llm_eval._call(mock_client, "prompt", "fallback", use_sc=True)

    assert result["score"] == 7  # median of [5, 7, 9]
    assert mock_client.chat.completions.create.call_count == 3


def test_n3_reasoning_includes_all_runs():
    settings.grader_self_consistency_n = 3
    mock_client = _make_mock_client_with_scores([5, 9, 7])

    result = llm_eval._call(mock_client, "prompt", "fallback", use_sc=True)

    assert "[run 1]" in result["reasoning"]
    assert "[run 2]" in result["reasoning"]
    assert "[run 3]" in result["reasoning"]


def test_use_sc_false_always_one_call_regardless_of_n():
    settings.grader_self_consistency_n = 3
    mock_client = _make_mock_client_with_scores([8])

    result = llm_eval._call(mock_client, "prompt", "fallback", use_sc=False)

    assert mock_client.chat.completions.create.call_count == 1
    assert result["score"] == 8
