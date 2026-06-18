"""Tests for the challenge-tests catalogue/source endpoints and the code-free
tests/traps surfaced on the session detail (challenge_tests.py + sessions.py).

Follows the in-process ASGITransport + respx harness from test_repo_files.py;
mint_installation_token is stubbed globally by conftest.py.
"""
from __future__ import annotations

import os
import tempfile

import pytest
from httpx import ASGITransport, AsyncClient

_db_fd, _db_path = tempfile.mkstemp(suffix=".db")
os.environ.update({
    "OPENAI_API_KEY": "sk-test",
    "GITHUB_CHALLENGES_REPO": "test-org/cpp-thread-safe-cache",
    "GITHUB_CHALLENGES_OWNER": "",
    "ADMIN_TOKEN": "admin-secret",
    "DB_PATH": _db_path,
    "LLM_BASE_URL": "https://openrouter.ai/api/v1",
})

from vibe.main import app  # noqa: E402
from vibe.db import bootstrap, execute  # noqa: E402
import vibe.auth as _auth  # noqa: E402

bootstrap()

_ADMIN = {"X-Admin-Token": "admin-secret"}
_CID = "cpp-thread-safe-cache"
_REPO = "test-org/cpp-thread-safe-cache"
_GH_REF = f"https://api.github.com/repos/{_REPO}/git/ref/heads/main"
_GH_REFS = f"https://api.github.com/repos/{_REPO}/git/refs"


@pytest.fixture(autouse=True)
def _clean():
    _auth._rate_limits.clear()
    for tbl in ("grading_errors", "grades", "chat_exchanges", "telemetry", "sessions"):
        execute(f"DELETE FROM {tbl}")
    yield


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def test_catalogue_lists_cases_with_docstrings(client):
    r = await client.get(f"/api/v1/challenges/{_CID}/tests", headers=_ADMIN)
    assert r.status_code == 200
    data = r.json()
    assert data["language"] == "cpp"
    # Every authored test case is present with its visibility + tags + docstring.
    by_name = {t["name"]: t for t in data["tests"]}
    pub = by_name["basic get and put"]
    assert pub["visibility"] == "public"
    assert pub["tags"] == ["basic"]
    assert pub["doc"]  # the @doc: one-liner was parsed
    hidden = by_name["concurrent reads of shared keys are race-free"]
    assert hidden["visibility"] == "hidden"
    assert hidden["tags"] == ["thread"]
    # Traps carry their short summary + detection tag, no code.
    trap_ids = {t["id"] for t in data["traps"]}
    assert {"race", "off_by_one", "capacity_zero"} <= trap_ids
    race = next(t for t in data["traps"] if t["id"] == "race")
    assert race["detection_tag"] == "[thread]"


async def test_catalogue_is_code_free(client):
    body = (await client.get(f"/api/v1/challenges/{_CID}/tests", headers=_ADMIN)).text
    assert "REQUIRE(" not in body
    assert "TEST_CASE(" not in body


async def test_code_endpoint_returns_source(client):
    r = await client.get(f"/api/v1/challenges/{_CID}/tests/code", headers=_ADMIN)
    assert r.status_code == 200
    vis = {f["visibility"]: f for f in r.json()["files"]}
    assert set(vis) == {"public", "hidden"}
    assert vis["public"]["filename"] == "public_test.cpp"
    assert vis["public"]["code_fence"] == "cpp"
    assert "TEST_CASE(" in vis["public"]["code"]
    assert "TEST_CASE(" in vis["hidden"]["code"]
    assert vis["public"]["cases"]  # parsed per-case docstrings travel with code


async def test_code_endpoint_visibility_filter(client):
    r = await client.get(
        f"/api/v1/challenges/{_CID}/tests/code", params={"visibility": "public"}, headers=_ADMIN
    )
    assert r.status_code == 200
    assert [f["visibility"] for f in r.json()["files"]] == ["public"]


async def test_code_endpoint_bad_visibility_400(client):
    r = await client.get(
        f"/api/v1/challenges/{_CID}/tests/code", params={"visibility": "nope"}, headers=_ADMIN
    )
    assert r.status_code == 400


async def test_endpoints_require_admin_token(client):
    assert (await client.get(f"/api/v1/challenges/{_CID}/tests")).status_code == 403
    assert (await client.get(f"/api/v1/challenges/{_CID}/tests/code")).status_code == 403


async def test_unknown_challenge_404(client):
    r = await client.get("/api/v1/challenges/no-such-challenge/tests", headers=_ADMIN)
    assert r.status_code == 404


async def test_session_detail_includes_code_free_tests_and_traps(client):
    # Detail surfaces the challenge tests/traps regardless of grade status, so a
    # freshly-created (pending) session already carries them — no need to
    # activate (which would require mocking the GitHub branch-provision chain).
    r = await client.post(
        "/api/v1/sessions",
        json={"session_key": "CT-1", "candidate_email": "c@test.com", "challenge_id": _CID},
        headers=_ADMIN,
    )
    assert r.status_code == 201
    session_id = r.json()["session_id"]

    resp = await client.get(f"/api/v1/sessions/{session_id}", headers=_ADMIN)
    d = resp.json()
    assert {t["id"] for t in d["challenge_tests"]}  # non-empty test groups
    assert {t["id"] for t in d["challenge_traps"]} >= {"race", "off_by_one"}
    for entry in d["challenge_tests"] + d["challenge_traps"]:
        assert set(entry) == {"id", "description"}  # code-free shape
    assert "TEST_CASE(" not in resp.text  # detail never carries test source
