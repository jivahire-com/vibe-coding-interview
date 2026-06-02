"""Tests for the recruiter challenge-repo file editor (vibe.repo_files) and the
`source_ref` invite plumbing.

Follows the in-process ASGITransport + respx pattern from test_e2e.py. GitHub
HTTP is mocked with respx; mint_installation_token is stubbed globally by
conftest.py so nothing touches the real GitHub API.
"""
from __future__ import annotations

import os
import tempfile

import pytest
import respx
from httpx import ASGITransport, AsyncClient, Response

# env must be set before vibe imports — see test_e2e.py for rationale.
_db_fd, _db_path = tempfile.mkstemp(suffix=".db")
os.environ.update({
    "OPENAI_API_KEY": "sk-test",
    "GITHUB_CHALLENGES_REPO": "test-org/cpp-lru-cache",
    "GITHUB_CHALLENGES_OWNER": "",
    "ADMIN_TOKEN": "admin-secret",
    "DB_PATH": _db_path,
    "LLM_BASE_URL": "https://openrouter.ai/api/v1",
})

from vibe.main import app  # noqa: E402
from vibe.db import bootstrap, execute, query  # noqa: E402
from vibe.config import repo_for_challenge  # noqa: E402
import vibe.auth as _auth  # noqa: E402

bootstrap()

_ADMIN = {"X-Admin-Token": "admin-secret"}
_CHALLENGE = "cpp-lru-cache"
# Derive the repo from settings rather than hardcoding: pydantic reads the env
# once at import time, so whichever test module imports vibe.config first fixes
# the value. repo_for_challenge() reflects whatever that ended up being.
_REPO = repo_for_challenge(_CHALLENGE)
_BASE = "/api/v1/admin/repos"


@pytest.fixture(autouse=True)
def _clean():
    _auth._rate_limits.clear()
    for tbl in ("app_logs", "grading_errors", "grades", "jobs", "chat_exchanges", "telemetry", "sessions"):
        execute(f"DELETE FROM {tbl}")
    yield


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


# ── .jivahire/ is blocked on read and write ─────────────────────────────────

async def test_get_protected_file_is_403(client):
    r = await client.get(
        f"{_BASE}/{_CHALLENGE}/file",
        params={"path": ".jivahire/hidden_tests.py"},
        headers=_ADMIN,
    )
    assert r.status_code == 403


async def test_save_protected_file_is_403(client):
    r = await client.post(
        f"{_BASE}/{_CHALLENGE}/save",
        json={"branch": "variant/x", "path": ".jivahire/rubric.json", "content": "{}"},
        headers=_ADMIN,
    )
    assert r.status_code == 403


async def test_tree_filters_out_jivahire(client):
    tree = {"tree": [
        {"path": "src/cache.cpp", "type": "blob", "sha": "a1"},
        {"path": "README.md", "type": "blob", "sha": "a2"},
        {"path": ".jivahire", "type": "tree", "sha": "d0"},
        {"path": ".jivahire/hidden_tests.py", "type": "blob", "sha": "a3"},
        {"path": ".jivahire/rubric.json", "type": "blob", "sha": "a4"},
    ]}
    with respx.mock:
        respx.get(path=f"/repos/{_REPO}/git/trees/main").mock(
            return_value=Response(200, json=tree)
        )
        r = await client.get(f"{_BASE}/{_CHALLENGE}/tree", headers=_ADMIN)
    assert r.status_code == 200
    paths = [f["path"] for f in r.json()["files"]]
    assert paths == ["README.md", "src/cache.cpp"]
    assert not any(p.startswith(".jivahire") for p in paths)


# ── branch namespace rules ──────────────────────────────────────────────────

async def test_save_to_non_variant_branch_is_400(client):
    r = await client.post(
        f"{_BASE}/{_CHALLENGE}/save",
        json={"branch": "main", "path": "src/cache.cpp", "content": "x"},
        headers=_ADMIN,
    )
    assert r.status_code == 400


async def test_branches_excludes_candidate_branches(client):
    branches = [
        {"name": "main"},
        {"name": "variant/easier"},
        {"name": "interview/abc123"},
    ]
    with respx.mock:
        respx.get(path=f"/repos/{_REPO}/branches").mock(
            return_value=Response(200, json=branches)
        )
        r = await client.get(f"{_BASE}/{_CHALLENGE}/branches", headers=_ADMIN)
    assert r.status_code == 200
    assert r.json()["branches"] == ["main", "variant/easier"]


# ── save creates the variant branch then commits ────────────────────────────

async def test_save_creates_variant_and_commits(client):
    with respx.mock:
        ref = respx.get(path=f"/repos/{_REPO}/git/ref/heads/main").mock(
            return_value=Response(200, json={"object": {"sha": "base-sha"}})
        )
        refs = respx.post(path=f"/repos/{_REPO}/git/refs").mock(return_value=Response(201))
        put = respx.put(path=f"/repos/{_REPO}/contents/src/cache.cpp").mock(
            return_value=Response(201, json={"content": {"sha": "new-blob"}, "commit": {"sha": "c1"}})
        )
        r = await client.post(
            f"{_BASE}/{_CHALLENGE}/save",
            json={
                "branch": "variant/easier",
                "path": "src/cache.cpp",
                "content": "int main() {}",
                "sha": "old-blob",
                "base_ref": "main",
            },
            headers=_ADMIN,
        )
    assert r.status_code == 200
    assert ref.called and refs.called and put.called
    body = r.json()
    assert body["branch"] == "variant/easier"
    assert body["sha"] == "new-blob"


# ── auth ────────────────────────────────────────────────────────────────────

async def test_endpoints_require_admin_token(client):
    r = await client.get(f"{_BASE}/{_CHALLENGE}/branches")
    assert r.status_code == 403


# ── source_ref plumbing: invite → DB → validate-session branch cut ──────────

async def test_create_session_persists_source_ref(client):
    r = await client.post(
        "/api/v1/sessions",
        json={
            "session_key": "SR-001",
            "candidate_email": "c@test.com",
            "challenge_id": _CHALLENGE,
            "source_ref": "variant/easier",
        },
        headers=_ADMIN,
    )
    assert r.status_code == 201
    row = query("SELECT source_ref FROM sessions WHERE session_key = ?", ("SR-001",))[0]
    assert row["source_ref"] == "variant/easier"


async def test_create_session_rejects_bad_source_ref(client):
    r = await client.post(
        "/api/v1/sessions",
        json={
            "session_key": "SR-BAD",
            "candidate_email": "c@test.com",
            "challenge_id": _CHALLENGE,
            "source_ref": "interview/sneaky",
        },
        headers=_ADMIN,
    )
    assert r.status_code == 400


async def test_validate_session_cuts_branch_from_variant(client):
    # Create a session assigned to a variant ref.
    r = await client.post(
        "/api/v1/sessions",
        json={
            "session_key": "SR-002",
            "candidate_email": "c@test.com",
            "challenge_id": _CHALLENGE,
            "source_ref": "variant/easier",
        },
        headers=_ADMIN,
    )
    assert r.status_code == 201

    with respx.mock:
        variant_ref = respx.get(
            path=f"/repos/{_REPO}/git/ref/heads/variant/easier"
        ).mock(return_value=Response(200, json={"object": {"sha": "variant-sha"}}))
        main_ref = respx.get(path=f"/repos/{_REPO}/git/ref/heads/main").mock(
            return_value=Response(200, json={"object": {"sha": "main-sha"}})
        )
        respx.post(path=f"/repos/{_REPO}/git/refs").mock(return_value=Response(201))
        r = await client.post("/api/v1/validate-session", json={"session_key": "SR-002"})

    assert r.status_code == 200
    # The candidate branch must be cut from the variant, never from main.
    assert variant_ref.called
    assert not main_ref.called
