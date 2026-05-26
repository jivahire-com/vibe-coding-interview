"""Focused tests for vibe/github_app.py.

The e2e tests stub `mint_installation_token` to keep them GitHub-free; these
tests exercise the JWT signing + HTTP call path that the stub bypasses.

Generates a throwaway RSA keypair per session — no test secrets are committed
to the repo, and `cryptography` is already a transitive dependency of PyJWT.
"""

import os
import tempfile

import httpx
import pytest
import respx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from httpx import Response

# Generate a test RSA keypair and stage env vars BEFORE importing vibe.config —
# pydantic-settings reads env at import time.
_db_fd, _db_path = tempfile.mkstemp(suffix=".db")
_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_pem = _key.private_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PrivateFormat.TraditionalOpenSSL,
    encryption_algorithm=serialization.NoEncryption(),
).decode("utf-8")

os.environ.setdefault("OPENAI_API_KEY", "sk-test")
os.environ.setdefault("GITHUB_CHALLENGES_REPO", "test-org/test-repo")
os.environ.setdefault("GITHUB_CHALLENGES_OWNER", "")
os.environ.setdefault("ADMIN_TOKEN", "admin-secret")
os.environ.setdefault("DB_PATH", _db_path)

from vibe import github_app  # noqa: E402
from vibe.config import settings  # noqa: E402


pytestmark = pytest.mark.real_github_app


@pytest.fixture(autouse=True)
def _real_app_creds(monkeypatch):
    """Inject a real RSA keypair into settings for the JWT-signing path.

    The conftest sets a placeholder PEM in env so other test files can run
    without crypto, but those bytes can't be parsed by PyJWT. For THIS file
    (the only one that exercises the real signing path) we override the
    settings object directly — bypassing pydantic's frozen-at-import-time
    env reading.
    """
    monkeypatch.setattr(settings, "github_app_id", 424242)
    monkeypatch.setattr(settings, "github_app_installation_id", 99)
    monkeypatch.setattr(settings, "github_app_private_key", _pem)
    github_app._reset_cache_for_tests()
    yield
    github_app._reset_cache_for_tests()


def test_normalize_private_key_handles_escaped_newlines():
    """Single-line PEM (newlines as `\\n`) is a common .env convention."""
    raw = "-----BEGIN RSA PRIVATE KEY-----\\nABC\\n-----END RSA PRIVATE KEY-----"
    out = github_app._normalize_private_key(raw)
    assert b"\n" in out
    assert b"\\n" not in out
    assert out.startswith(b"-----BEGIN")


def test_normalize_private_key_passes_real_newlines_through():
    raw = "-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----"
    out = github_app._normalize_private_key(raw)
    assert b"\\n" not in out
    assert out.count(b"\n") == 2


async def test_mint_installation_token_signs_jwt_and_scopes_to_repo(respx_mock):
    """Pins the wire contract: the request to GitHub must scope the token to
    exactly one repository and use the App's RS256-signed JWT."""
    captured: dict = {}

    def _capture(request: httpx.Request) -> Response:
        captured["auth"] = request.headers.get("authorization")
        captured["json"] = httpx.Request(method="POST", url=str(request.url), content=request.content)
        # Re-read JSON body for inspection.
        import json
        captured["body"] = json.loads(request.content)
        return Response(
            201,
            json={"token": "ghs_minted_xyz", "expires_at": "2026-01-01T00:00:00Z"},
        )

    url = f"https://api.github.com/app/installations/{settings.github_app_installation_id}/access_tokens"
    respx_mock.post(url).mock(side_effect=_capture)

    tok = await github_app.mint_installation_token("test-org/test-repo")

    assert tok.token == "ghs_minted_xyz"
    # 2026-01-01T00:00:00Z → 1767225600
    assert tok.expires_at == 1767225600

    # Token request is scoped to exactly the candidate's repo (defense in depth).
    assert captured["body"]["repositories"] == ["test-repo"]
    # Permissions are the minimum needed (contents:write for clone+push+branch).
    assert captured["body"]["permissions"] == {"contents": "write"}
    # Auth header uses the JWT — never a PAT.
    assert captured["auth"].startswith("Bearer ")
    assert "ghp_" not in captured["auth"], "must not pass a PAT to GitHub"


async def test_mint_installation_token_raises_on_github_error(respx_mock):
    url = f"https://api.github.com/app/installations/{settings.github_app_installation_id}/access_tokens"
    respx_mock.post(url).mock(return_value=Response(401, text="bad credentials"))
    with pytest.raises(RuntimeError, match="status=401"):
        await github_app.mint_installation_token("test-org/test-repo")


async def test_mint_installation_token_validates_repo_form():
    with pytest.raises(ValueError):
        await github_app.mint_installation_token("not-a-full-name")
