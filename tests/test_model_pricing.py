"""Unit + integration coverage for the multi-model picker added to chat.

Verifies:
  - `compute_cost` uses the per-model pricing table — billing GPT-4o-mini at
    Opus rates (or vice versa) would silently blow / underspend the budget.
  - `pricing_for` falls back to the default when handed an unknown model so
    legacy `chat_exchanges` rows aren't punished by a None entry.
  - The chat-completions endpoint accepts each newly added model id and
    rejects unknown ids with a 400 (allowlist boundary).
  - `validate-session` advertises all four models AND ships a pricing table
    the extension can consume.
"""
import os
import tempfile

import pytest
import respx
from httpx import ASGITransport, AsyncClient, Response
from unittest.mock import AsyncMock, patch

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
from vibe.budget import MODEL_PRICING, compute_cost, pricing_for  # noqa: E402
from vibe.config import settings  # noqa: E402

bootstrap()

_REPO = "test-org/test-repo"
_ADMIN = {"X-Admin-Token": "admin-secret"}
_GH_REF = f"https://api.github.com/repos/{_REPO}/git/ref/heads/main"
_GH_REFS = f"https://api.github.com/repos/{_REPO}/git/refs"

_ALL_FOUR = (
    "openai/gpt-4o-mini,"
    "google/gemini-2.5-flash-lite,"
    "anthropic/claude-opus-4.6,"
    "anthropic/claude-sonnet-4.6"
)


@pytest.fixture(autouse=True)
def _clean():
    _auth._rate_limits.clear()
    for tbl in ("grading_errors", "grades", "jobs", "chat_exchanges", "telemetry", "sessions"):
        execute(f"DELETE FROM {tbl}")
    original = settings.candidate_chat_models
    settings.candidate_chat_models = _ALL_FOUR
    yield
    settings.candidate_chat_models = original


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
async def active_session(client):
    with respx.mock:
        respx.get(_GH_REF).mock(return_value=Response(200, json={"object": {"sha": "abc"}}))
        respx.post(_GH_REFS).mock(return_value=Response(201))
        r = await client.post(
            "/api/v1/sessions",
            json={"session_key": "MP-001", "candidate_email": "c@test.com", "challenge_id": "cpp-thread-safe-cache"},
            headers=_ADMIN,
        )
        assert r.status_code == 201
        r2 = await client.post("/api/v1/validate-session", json={"session_key": "MP-001"})
        assert r2.status_code == 200
        return "MP-001", r2.json()


# ── unit: per-model pricing table ─────────────────────────────────────────

def test_pricing_table_contains_all_four_models():
    for model in (
        "openai/gpt-4o-mini",
        "google/gemini-2.5-flash-lite",
        "anthropic/claude-opus-4.6",
        "anthropic/claude-sonnet-4.6",
    ):
        assert model in MODEL_PRICING
        entry = MODEL_PRICING[model]
        assert {"input", "cached_input", "output"} <= entry.keys()
        # Sanity: output is always >= input (providers charge more for completion)
        assert entry["output"] >= entry["input"]


def test_compute_cost_uses_gpt_4o_mini_rates_when_unspecified():
    # Back-compat: callers that don't pass `model` must keep their old billing.
    cost = compute_cost(prompt_tokens=1_000_000, completion_tokens=1_000_000)
    expected = 0.15 + 0.60  # gpt-4o-mini rates
    assert cost == pytest.approx(expected, rel=1e-6)


def test_compute_cost_uses_opus_rates_for_opus_model():
    cost = compute_cost(
        prompt_tokens=1_000_000,
        completion_tokens=1_000_000,
        model="anthropic/claude-opus-4.6",
    )
    # Opus is 100× pricier than 4o-mini on input, 125× on output.
    expected = 15.0 + 75.0
    assert cost == pytest.approx(expected, rel=1e-6)


def test_compute_cost_uses_sonnet_rates_for_sonnet_model():
    cost = compute_cost(
        prompt_tokens=1_000_000,
        completion_tokens=1_000_000,
        model="anthropic/claude-sonnet-4.6",
    )
    expected = 3.0 + 15.0
    assert cost == pytest.approx(expected, rel=1e-6)


def test_compute_cost_uses_gemini_rates_for_gemini_model():
    cost = compute_cost(
        prompt_tokens=1_000_000,
        completion_tokens=1_000_000,
        model="google/gemini-2.5-flash-lite",
    )
    expected = 0.10 + 0.40
    assert cost == pytest.approx(expected, rel=1e-6)


def test_compute_cost_cached_input_discount_per_model():
    # Opus: $15 uncached vs $1.50 cached — a 10× discount.
    full = compute_cost(prompt_tokens=1_000_000, completion_tokens=0,
                        model="anthropic/claude-opus-4.6")
    cached = compute_cost(prompt_tokens=1_000_000, completion_tokens=0,
                          cached_input_tokens=1_000_000,
                          model="anthropic/claude-opus-4.6")
    assert cached == pytest.approx(full / 10, rel=1e-6)


def test_pricing_for_unknown_model_falls_back_to_default():
    rates = pricing_for("some/unreleased-model")
    assert rates == MODEL_PRICING["openai/gpt-4o-mini"]


# ── integration: validate-session ships pricing + advertises all models ───

async def test_validate_session_lists_all_four_models(active_session):
    _, data = active_session
    models = data["available_chat_models"]
    assert set(models) == {
        "openai/gpt-4o-mini",
        "google/gemini-2.5-flash-lite",
        "anthropic/claude-opus-4.6",
        "anthropic/claude-sonnet-4.6",
    }


async def test_validate_session_includes_pricing_per_million(active_session):
    _, data = active_session
    pricing = data["pricing_per_million"]
    for m in (
        "openai/gpt-4o-mini",
        "google/gemini-2.5-flash-lite",
        "anthropic/claude-opus-4.6",
        "anthropic/claude-sonnet-4.6",
    ):
        assert m in pricing
        assert pricing[m]["input"] == MODEL_PRICING[m]["input"]
        assert pricing[m]["output"] == MODEL_PRICING[m]["output"]
        assert pricing[m]["cached_input"] == MODEL_PRICING[m]["cached_input"]


async def test_validate_session_default_chat_model_is_gpt_4o_mini(active_session):
    _, data = active_session
    assert data["chat_model"] == "openai/gpt-4o-mini"


# ── integration: chat endpoint accepts each new model id ──────────────────

def _async_iter(items):
    async def gen():
        for it in items:
            yield it
    return gen()


def _fake_openai_client(captured: dict):
    fake = AsyncMock()

    async def fake_create(*, model, messages, stream, stream_options):
        captured["model"] = model
        return _async_iter([])

    fake.chat.completions.create = fake_create
    return fake


@pytest.mark.parametrize("model", [
    "openai/gpt-4o-mini",
    "google/gemini-2.5-flash-lite",
    "anthropic/claude-opus-4.6",
    "anthropic/claude-sonnet-4.6",
])
async def test_chat_endpoint_accepts_each_new_model(client, active_session, model):
    key, _ = active_session
    captured: dict = {}
    with patch("vibe.llm_proxy._get_client", return_value=_fake_openai_client(captured)):
        r = await client.post(
            "/api/v1/llm/chat/completions",
            json={"messages": [{"role": "user", "content": "hi"}], "model": model},
            headers={"Authorization": f"Bearer {key}"},
        )
        assert r.status_code == 200
        await r.aread()
    assert captured["model"] == model


async def test_chat_endpoint_rejects_unknown_model(client, active_session):
    key, _ = active_session
    r = await client.post(
        "/api/v1/llm/chat/completions",
        json={"messages": [{"role": "user", "content": "hi"}], "model": "anthropic/claude-3-haiku"},
        headers={"Authorization": f"Bearer {key}"},
    )
    assert r.status_code == 400
    assert "not in the allowed list" in r.text
