import json
import os
import tempfile
from unittest.mock import MagicMock, call

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


def _seed_exchange(sid: str, ts: int, classification: str, prompt_text: str) -> None:
    execute(
        "INSERT INTO chat_exchanges (session_id, ts, model, prompt_tokens, completion_tokens, "
        "cost_usd, prompt_text, prompt_classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (sid, ts, "test-model", 10, 20, 0.001, prompt_text, classification),
    )


def test_prompt_quality_score_is_deterministic():
    """Score must equal the weighted formula regardless of LLM response."""
    sid = "pq-001"
    _seed_session(sid)
    _seed_exchange(sid, 1000, "professional", "function put() crashes with capacity=0 because eviction check uses > not >=")
    _seed_exchange(sid, 2000, "specific", "the get() method returns -1 for keys that should be in cache")
    _seed_exchange(sid, 3000, "vague", "fix this please")

    # 1 professional, 1 specific, 1 vague → (10 + 7 + 3) / 3 = 6.67 → rounds to 7
    expected_score = round((10 + 7 + 3) / 3)

    # The classification LLM call returns pre-seeded data (classifications are already in DB)
    # We mock the classification call to return matching classifications, then commentary call for text
    mock_client = MagicMock()
    classify_resp = MagicMock()
    classify_resp.choices[0].message.content = json.dumps([
        {"index": 1, "classification": "professional", "reason": "precise"},
        {"index": 2, "classification": "specific", "reason": "describes symptom"},
        {"index": 3, "classification": "vague", "reason": "generic"},
    ])
    commentary_resp = MagicMock()
    commentary_resp.choices[0].message.content = "Candidate showed mixed prompting quality."
    mock_client.chat.completions.create.side_effect = [classify_resp, commentary_resp]

    chat_log = [
        {"prompt_text": "function put() crashes with capacity=0 because eviction check uses > not >="},
        {"prompt_text": "the get() method returns -1 for keys that should be in cache"},
        {"prompt_text": "fix this please"},
    ]
    result = llm_eval._eval_prompt_quality(mock_client, sid, chat_log)

    assert result["score"] == expected_score
    assert mock_client.chat.completions.create.call_count == 2  # classify + commentary, not a third scoring call


def test_all_professional_scores_ten():
    sid = "pq-002"
    _seed_session(sid)

    mock_client = MagicMock()
    classify_resp = MagicMock()
    classify_resp.choices[0].message.content = json.dumps([
        {"index": 1, "classification": "professional", "reason": "x"},
        {"index": 2, "classification": "professional", "reason": "y"},
    ])
    commentary_resp = MagicMock()
    commentary_resp.choices[0].message.content = "All prompts were precise."
    mock_client.chat.completions.create.side_effect = [classify_resp, commentary_resp]

    chat_log = [{"prompt_text": "precise error description"}, {"prompt_text": "another precise prompt"}]
    result = llm_eval._eval_prompt_quality(mock_client, sid, chat_log)

    assert result["score"] == 10


def test_all_vague_scores_three():
    sid = "pq-003"
    _seed_session(sid)

    mock_client = MagicMock()
    classify_resp = MagicMock()
    classify_resp.choices[0].message.content = json.dumps([
        {"index": 1, "classification": "vague", "reason": "generic"},
        {"index": 2, "classification": "vague", "reason": "generic"},
    ])
    commentary_resp = MagicMock()
    commentary_resp.choices[0].message.content = "All prompts were vague."
    mock_client.chat.completions.create.side_effect = [classify_resp, commentary_resp]

    chat_log = [{"prompt_text": "fix it"}, {"prompt_text": "make it work"}]
    result = llm_eval._eval_prompt_quality(mock_client, sid, chat_log)

    assert result["score"] == 3
