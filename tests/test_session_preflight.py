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
    yield


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
async def pending_session(client):
    """A created-but-not-yet-validated session (status='pending')."""
    r = await client.post(
        "/api/v1/sessions",
        json={"session_key": "PF-001", "candidate_email": "c@test.com", "challenge_id": "cpp-lru-cache"},
        headers=_ADMIN,
    )
    assert r.status_code == 201
    return "PF-001"


async def test_preflight_returns_language_and_dependencies(client, pending_session):
    r = await client.post("/api/v1/session-preflight", json={"session_key": "PF-001"})
    assert r.status_code == 200
    data = r.json()
    assert data["challenge_id"] == "cpp-lru-cache"
    assert data["language"] == "cpp"
    labels = [d["label"] for d in data["dependencies"]]
    checks = [d["check"] for d in data["dependencies"]]
    assert "cmake --version" in checks
    assert any("CMake" in lbl for lbl in labels)


async def test_preflight_does_not_activate_session(client, pending_session):
    """Preflight is read-only — the session must stay 'pending' (timer not started)."""
    before = query("SELECT status, started_at FROM sessions WHERE session_key=?", ("PF-001",))[0]
    assert before["status"] == "pending"
    r = await client.post("/api/v1/session-preflight", json={"session_key": "PF-001"})
    assert r.status_code == 200
    after = query("SELECT status, started_at FROM sessions WHERE session_key=?", ("PF-001",))[0]
    assert after["status"] == "pending"
    assert after["started_at"] is None


async def test_preflight_unknown_key_404(client):
    r = await client.post("/api/v1/session-preflight", json={"session_key": "NOPE"})
    assert r.status_code == 404


async def test_preflight_rate_limited(client, pending_session):
    # 5 attempts/IP/hour; the 6th is rejected before any work.
    for _ in range(5):
        await client.post("/api/v1/session-preflight", json={"session_key": "PF-001"})
    r = await client.post("/api/v1/session-preflight", json={"session_key": "PF-001"})
    assert r.status_code == 429


async def test_validate_session_returns_language(client, pending_session):
    with respx.mock:
        respx.get(_GH_REF).mock(return_value=Response(200, json={"object": {"sha": "abc123"}}))
        respx.post(_GH_REFS).mock(return_value=Response(201))
        r = await client.post("/api/v1/validate-session", json={"session_key": "PF-001"})
    assert r.status_code == 200
    assert r.json()["language"] == "cpp"
