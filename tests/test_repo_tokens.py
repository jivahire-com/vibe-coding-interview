import json
import os
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "sk-test")
os.environ["GITHUB_CHALLENGES_OWNER"] = ""
os.environ.setdefault("GITHUB_CHALLENGES_REPO", "test-org/test-repo")
os.environ.setdefault("ADMIN_TOKEN", "admin-secret")


@pytest.fixture
def challenge_dir(tmp_path):
    (tmp_path / ".jivahire").mkdir()
    (tmp_path / "main.cpp").write_text("int main() { return 0; }")
    (tmp_path / "README.md").write_text("# Challenge\nSolve it.")
    return tmp_path


def _mock_client(prompt_tokens: int = 500):
    client = MagicMock()
    usage = MagicMock()
    usage.prompt_tokens = prompt_tokens
    resp = MagicMock()
    resp.usage = usage
    client.chat.completions.create.return_value = resp
    return client


def test_first_call_invokes_provider(challenge_dir):
    from vibe.grader.repo_tokens import get_repo_tokens

    with patch("vibe.grader.repo_tokens.OpenAI", return_value=_mock_client(500)):
        count = get_repo_tokens(challenge_dir, "openai/gpt-4o-mini")

    assert count == 500 - 6 - 3  # overhead subtraction
    cache_path = challenge_dir / ".jivahire" / "token_counts.json"
    assert cache_path.exists()
    cached = json.loads(cache_path.read_text())
    assert cached["repo_tokens"] == count
    assert cached["model"] == "openai/gpt-4o-mini"


def test_second_call_uses_cache(challenge_dir):
    from vibe.grader.repo_tokens import get_repo_tokens

    mock_client = _mock_client(500)
    with patch("vibe.grader.repo_tokens.OpenAI", return_value=mock_client):
        get_repo_tokens(challenge_dir, "openai/gpt-4o-mini")
        get_repo_tokens(challenge_dir, "openai/gpt-4o-mini")

    # Provider called only once — second call used disk cache
    assert mock_client.chat.completions.create.call_count == 1


def test_cache_invalidated_on_file_change(challenge_dir):
    from vibe.grader.repo_tokens import get_repo_tokens

    mock_client = _mock_client(500)
    with patch("vibe.grader.repo_tokens.OpenAI", return_value=mock_client):
        get_repo_tokens(challenge_dir, "openai/gpt-4o-mini")

    # Modify a source file
    (challenge_dir / "main.cpp").write_text("int main() { return 42; }")

    with patch("vibe.grader.repo_tokens.OpenAI", return_value=mock_client):
        get_repo_tokens(challenge_dir, "openai/gpt-4o-mini")

    assert mock_client.chat.completions.create.call_count == 2
