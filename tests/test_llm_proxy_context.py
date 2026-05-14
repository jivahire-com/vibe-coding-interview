import os
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

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
})

from vibe.main import app  # noqa: E402
from vibe.db import bootstrap, execute  # noqa: E402
import vibe.auth as _auth  # noqa: E402
import vibe.challenge_context as cc  # noqa: E402
from vibe.budget import compute_cost  # noqa: E402
from vibe.config import settings  # noqa: E402

bootstrap()

_REPO = "test-org/test-repo"
_ADMIN = {"X-Admin-Token": "admin-secret"}
_GH_REF = f"https://api.github.com/repos/{_REPO}/git/ref/heads/main"
_GH_REFS = f"https://api.github.com/repos/{_REPO}/git/refs"


@pytest.fixture(autouse=True)
def _clean():
    _auth._rate_limits.clear()
    cc.clear_cache()
    for tbl in ("grading_errors", "grades", "jobs", "chat_exchanges", "telemetry", "sessions"):
        execute(f"DELETE FROM {tbl}")
    yield


@pytest.fixture
def fake_challenges_dir(tmp_path):
    challenge = tmp_path / "demo-challenge"
    (challenge / ".jivahire").mkdir(parents=True)
    (challenge / ".jivahire" / "rubric.json").write_text('{"secret": "SHOULD_NOT_LEAK"}')
    (challenge / ".jivahire" / "traps.json").write_text('{"trap": "SHOULD_NOT_LEAK"}')
    (challenge / "src").mkdir()
    (challenge / "src" / "ttl_cache.py").write_text("def get(): return 1\n")
    (challenge / "README.md").write_text("# Demo challenge\nFix the bug.\n")
    original = settings.challenges_dir
    settings.challenges_dir = str(tmp_path)
    yield tmp_path
    settings.challenges_dir = original


# ── unit: get_challenge_context ────────────────────────────────────────────

def test_get_challenge_context_includes_source_and_readme(fake_challenges_dir):
    dump = cc.get_challenge_context("demo-challenge")
    assert "src/ttl_cache.py" in dump
    assert "def get(): return 1" in dump
    assert "README.md" in dump
    assert "Fix the bug." in dump


def test_get_challenge_context_excludes_jivahire(fake_challenges_dir):
    dump = cc.get_challenge_context("demo-challenge")
    assert "SHOULD_NOT_LEAK" not in dump
    assert "rubric.json" not in dump
    assert "traps.json" not in dump


def test_get_challenge_context_caches_per_challenge(fake_challenges_dir):
    cc.get_challenge_context("demo-challenge")
    # Mutating the file on disk should not affect a cached result.
    (fake_challenges_dir / "demo-challenge" / "src" / "ttl_cache.py").write_text("# CHANGED\n")
    second = cc.get_challenge_context("demo-challenge")
    assert "def get(): return 1" in second
    assert "CHANGED" not in second


def test_get_challenge_context_missing_challenge_returns_empty(fake_challenges_dir):
    assert cc.get_challenge_context("does-not-exist") == ""


# ── unit: compute_cost discounts cached input ─────────────────────────────

def test_compute_cost_discounts_cached_tokens():
    full = compute_cost(prompt_tokens=1_000_000, completion_tokens=0)
    cached_all = compute_cost(prompt_tokens=1_000_000, completion_tokens=0, cached_input_tokens=1_000_000)
    assert cached_all == pytest.approx(full * 0.5)


def test_compute_cost_partial_cache():
    cost = compute_cost(prompt_tokens=1000, completion_tokens=0, cached_input_tokens=400)
    # 600 uncached at $0.15/M + 400 cached at $0.075/M
    expected = 600 / 1_000_000 * 0.15 + 400 / 1_000_000 * 0.075
    assert cost == pytest.approx(expected)


# ── integration: proxy injects dump into outgoing system message ──────────

def _async_iter(items):
    async def gen():
        for it in items:
            yield it
    return gen()


def _make_fake_openai_client(captured: dict):
    fake = AsyncMock()

    async def fake_create(*, model, messages, stream, stream_options):
        captured["messages"] = messages
        captured["model"] = model
        return _async_iter([])  # empty stream → no usage, no body

    fake.chat.completions.create = fake_create
    return fake


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
async def active_session(client, fake_challenges_dir):
    with respx.mock:
        respx.get(_GH_REF).mock(return_value=Response(200, json={"object": {"sha": "abc"}}))
        respx.post(_GH_REFS).mock(return_value=Response(201))
        r = await client.post(
            "/api/v1/sessions",
            json={
                "session_key": "CTX-001",
                "candidate_email": "c@test.com",
                "challenge_id": "demo-challenge",
            },
            headers=_ADMIN,
        )
        assert r.status_code == 201
        r2 = await client.post("/api/v1/validate-session", json={"session_key": "CTX-001"})
        assert r2.status_code == 200
    return "CTX-001"


async def test_proxy_injects_repo_dump_into_system_message(client, active_session):
    key = active_session
    captured: dict = {}
    with patch("vibe.llm_proxy._get_client", return_value=_make_fake_openai_client(captured)):
        resp = await client.post(
            "/api/v1/llm/chat/completions",
            json={"messages": [{"role": "user", "content": "what is this repo?"}]},
            headers={"Authorization": f"Bearer {key}"},
        )
        assert resp.status_code == 200
        # Drain stream so the handler runs end-to-end.
        await resp.aread()

    msgs = captured["messages"]
    assert msgs[0]["role"] == "system"
    sys_content = msgs[0]["content"]
    assert "Challenge Repository (initial state)" in sys_content
    assert "src/ttl_cache.py" in sys_content
    assert "def get(): return 1" in sys_content
    # Privacy regression guard
    assert "SHOULD_NOT_LEAK" not in sys_content
    # Original user message is preserved
    assert msgs[-1] == {"role": "user", "content": "what is this repo?"}
