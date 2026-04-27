import os
import tempfile
import threading

import pytest
import respx
from httpx import ASGITransport, AsyncClient, Response

# env must be set before vibe imports so pydantic-settings reads them
_db_fd, _db_path = tempfile.mkstemp(suffix=".db")
os.environ.update({
    "OPENAI_API_KEY": "sk-test",
    "GITHUB_BOT_PAT": "ghp-test",
    "GITHUB_CHALLENGES_REPO": "test-org/test-repo",
    "ADMIN_TOKEN": "admin-secret",
    "DB_PATH": _db_path,
    "LLM_BASE_URL": "https://openrouter.ai/api/v1",
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
    for tbl in ("grades", "jobs", "chat_exchanges", "telemetry", "sessions"):
        execute(f"DELETE FROM {tbl}")
    yield


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def _mock_github():
    respx.get(_GH_REF).mock(return_value=Response(200, json={"object": {"sha": "abc123"}}))
    respx.post(_GH_REFS).mock(return_value=Response(201))


async def _create_session(client, key: str) -> str:
    r = await client.post(
        "/api/v1/sessions",
        json={"session_key": key, "candidate_email": "c@test.com", "challenge_id": "cpp-lru-cache"},
        headers=_ADMIN,
    )
    assert r.status_code == 201
    return r.json()["session_id"]


@pytest.fixture
async def active_session(client):
    with respx.mock:
        _mock_github()
        sid = await _create_session(client, "TEST-001")
        await client.post("/api/v1/validate-session", json={"session_key": "TEST-001"})
    return "TEST-001", sid


# ── tests ────────────────────────────────────────────────────────────────────

async def test_rate_limit_validate_session(client):
    """6th validate-session from the same IP within an hour gets 429."""
    with respx.mock:
        _mock_github()
        for i in range(5):
            await _create_session(client, f"RL-{i:03d}")
            r = await client.post("/api/v1/validate-session", json={"session_key": f"RL-{i:03d}"})
            assert r.status_code == 200
        await _create_session(client, "RL-005")
        r = await client.post("/api/v1/validate-session", json={"session_key": "RL-005"})
    assert r.status_code == 429


async def test_telemetry_bulk_insert(client, active_session):
    key, _ = active_session
    events = [{"ts": 1_000_000 + i, "event_type": "edit_batch", "payload": {"chars": i}} for i in range(5)]
    r = await client.post(
        "/api/v1/telemetry",
        json={"events": events},
        headers={"Authorization": f"Bearer {key}"},
    )
    assert r.status_code == 204
    assert query("SELECT COUNT(*) as n FROM telemetry")[0]["n"] == 5


async def test_budget_exhausted_preflight(client, active_session):
    """Pre-flight budget check returns 402 before touching OpenRouter."""
    key, sid = active_session
    execute("UPDATE sessions SET llm_budget_usd = 0.0 WHERE id = ?", (sid,))
    r = await client.post(
        "/api/v1/llm/chat/completions",
        json={"messages": [{"role": "user", "content": "hello"}]},
        headers={"Authorization": f"Bearer {key}"},
    )
    assert r.status_code == 402


async def test_submit_enqueues_grade_job(client, active_session):
    key, sid = active_session
    r = await client.post("/api/v1/submit", headers={"Authorization": f"Bearer {key}"})
    assert r.status_code == 202
    jobs = query("SELECT status FROM jobs WHERE session_id = ?", (sid,))
    assert len(jobs) == 1 and jobs[0]["status"] == "pending"


async def test_job_claim_atomicity():
    """Two threads racing to claim the same pending job — exactly one wins."""
    from vibe.jobs import claim_job
    execute(
        "INSERT INTO sessions (id, session_key, candidate_email, challenge_id, branch_name, status) "
        "VALUES ('s1', 'K-001', 'x@x.com', 'cpp-lru-cache', 'interview/s1', 'submitted')"
    )
    execute("INSERT INTO jobs (kind, session_id) VALUES ('grade', 's1')")

    results: list = []

    def try_claim():
        results.append(claim_job())

    t1, t2 = threading.Thread(target=try_claim), threading.Thread(target=try_claim)
    t1.start(); t2.start()
    t1.join(); t2.join()
    assert len([r for r in results if r is not None]) == 1
