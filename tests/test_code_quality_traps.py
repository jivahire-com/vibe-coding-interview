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

from vibe.db import bootstrap, execute  # noqa: E402
from vibe.grader import llm_eval  # noqa: E402

bootstrap()


@pytest.fixture(autouse=True)
def _clean():
    for tbl in ("grading_errors", "grades", "jobs", "chat_exchanges", "telemetry", "sessions"):
        execute(f"DELETE FROM {tbl}")
    yield


_CTX = {
    "id": "cpp-lru-cache",
    "title": "LRU Cache",
    "description": "Make it thread-safe.",
    "language": "cpp",
    "code_fence": "cpp",
    "starter_code_note": "",
}

_RUBRIC = {"tasks": [], "code_quality_criteria": ["Correctness"]}

_DETECTED_TRAPS = [
    {"id": "race", "description": "Missing mutex synchronisation.", "detection_tag": "[thread]"},
]

_MISSED_TRAPS = [
    {"id": "off_by_one", "description": "Eviction loop off-by-one.", "detection_tag": "[basic]"},
    {"id": "capacity_zero", "description": "capacity=0 no-op not handled.", "detection_tag": "[edge]"},
]


def _make_mock_client(score: int = 7) -> MagicMock:
    mock_client = MagicMock()
    content = json.dumps({"analysis": "decent work", "score": score, "confidence": 0.8})
    mock_resp = MagicMock()
    mock_resp.choices[0].message.content = content
    mock_client.chat.completions.create.return_value = mock_resp
    return mock_client


def test_prompt_contains_caught_traps_section():
    mock_client = _make_mock_client()
    llm_eval._eval_code_quality(
        mock_client, _CTX, "int x = 1;", {}, _RUBRIC,
        _DETECTED_TRAPS, _MISSED_TRAPS, {}, "sid-unused",
    )
    prompt = mock_client.chat.completions.create.call_args[1]["messages"][0]["content"]
    assert "TRAPS THE CANDIDATE CAUGHT" in prompt
    assert "[race]" in prompt


def test_prompt_contains_missed_traps_section():
    mock_client = _make_mock_client()
    llm_eval._eval_code_quality(
        mock_client, _CTX, "int x = 1;", {}, _RUBRIC,
        _DETECTED_TRAPS, _MISSED_TRAPS, {}, "sid-unused",
    )
    prompt = mock_client.chat.completions.create.call_args[1]["messages"][0]["content"]
    assert "TRAPS THE CANDIDATE MISSED" in prompt
    assert "[off_by_one]" in prompt
    assert "[capacity_zero]" in prompt


def test_no_trap_sections_when_lists_empty():
    mock_client = _make_mock_client()
    llm_eval._eval_code_quality(
        mock_client, _CTX, "code", {}, _RUBRIC, [], [], {}, "sid-unused",
    )
    prompt = mock_client.chat.completions.create.call_args[1]["messages"][0]["content"]
    # Section headers (with trailing colon and newline) should not appear when lists are empty,
    # though the rule text in ADJUSTMENTS may still reference the header phrase.
    assert "TRAPS THE CANDIDATE CAUGHT:\n" not in prompt
    assert "TRAPS THE CANDIDATE MISSED:\n" not in prompt


def test_prompt_contains_score_anchors():
    mock_client = _make_mock_client()
    llm_eval._eval_code_quality(
        mock_client, _CTX, "code", {}, _RUBRIC,
        _DETECTED_TRAPS, _MISSED_TRAPS, {}, "sid-unused",
    )
    prompt = mock_client.chat.completions.create.call_args[1]["messages"][0]["content"]
    assert "SCORE ANCHORS" in prompt
    assert "9–10" in prompt
