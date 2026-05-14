import os
import tempfile

import pytest
import respx
from httpx import ASGITransport, AsyncClient, Response

_db_fd, _db_path = tempfile.mkstemp(suffix=".db")
os.environ.update({
    "OPENAI_API_KEY": "sk-test",
    "GITHUB_BOT_PAT": "ghp-test",
    "GITHUB_CHALLENGES_REPO": "test-org/test-repo",
    "GITHUB_CHALLENGES_OWNER": "",
    "ADMIN_TOKEN": "admin-secret",
    "DB_PATH": _db_path,
    "LLM_BASE_URL": "https://openrouter.ai/api/v1",
    "CANDIDATE_CHAT_MODELS": "openai/gpt-4o-mini,openai/gpt-4o",
})

from vibe.main import app  # noqa: E402
from vibe.db import bootstrap, execute, query  # noqa: E402
import vibe.auth as _auth  # noqa: E402

bootstrap()

_REPO = "test-org/test-repo"
_ADMIN = {"X-Admin-Token": "admin-secret"}
_GH_REF = f"https://api.github.com/repos/{_REPO}/git/ref/heads/main"
_GH_REFS = f"https://api.github.com/repos/{_REPO}/git/refs"


@pytest.fixture(autouse=True)
def _clean():
    _auth._rate_limits.clear()
    for tbl in ("grading_errors", "grades", "jobs", "chat_exchanges", "telemetry", "sessions"):
        execute(f"DELETE FROM {tbl}")
    # Patch settings to use the two-model allow-list for this test module
    from vibe.config import settings
    original = settings.candidate_chat_models
    settings.candidate_chat_models = "openai/gpt-4o-mini,openai/gpt-4o"
    yield
    settings.candidate_chat_models = original


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
async def active_session(client):
    with respx.mock:
        respx.get(_GH_REF).mock(return_value=Response(200, json={"object": {"sha": "abc123"}}))
        respx.post(_GH_REFS).mock(return_value=Response(201))
        r = await client.post(
            "/api/v1/sessions",
            json={"session_key": "ML-001", "candidate_email": "c@test.com", "challenge_id": "cpp-lru-cache"},
            headers=_ADMIN,
        )
        assert r.status_code == 201
        r2 = await client.post("/api/v1/validate-session", json={"session_key": "ML-001"})
        assert r2.status_code == 200
        data = r2.json()
    return "ML-001", data


async def test_validate_session_returns_available_chat_models(active_session):
    _, data = active_session
    assert "available_chat_models" in data
    assert "openai/gpt-4o-mini" in data["available_chat_models"]
    assert "openai/gpt-4o" in data["available_chat_models"]


async def test_disallowed_model_returns_400(client, active_session):
    key, _ = active_session
    r = await client.post(
        "/api/v1/llm/chat/completions",
        json={"messages": [{"role": "user", "content": "hi"}], "model": "openai/gpt-4-turbo"},
        headers={"Authorization": f"Bearer {key}"},
    )
    assert r.status_code == 400
