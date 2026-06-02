"""Shared test setup.

Two responsibilities:

1. Stage placeholder GitHub App env vars BEFORE any test module imports
   `vibe.config`. pydantic-settings reads `os.environ` and the `.env` file at
   import time; without this, tests on developer machines would silently
   pick up the real `.env` (with the live App credentials) and start hitting
   GitHub's `/access_tokens` endpoint. `setdefault` so any test module that
   already provides its own value still wins.

2. Stub `vibe.github_app.mint_installation_token` for every test. The
   autouse fixture below replaces it with a deterministic stub so no test —
   even a future one that forgets to mock — can leak credentials by talking
   to the real GitHub API.
"""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("GITHUB_APP_ID", "12345")
os.environ.setdefault("GITHUB_APP_INSTALLATION_ID", "67890")
os.environ.setdefault(
    "GITHUB_APP_PRIVATE_KEY",
    "-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----",
)


@pytest.fixture(autouse=True)
def _stub_github_mint(monkeypatch, request):
    """Replace mint_installation_token globally so tests never hit GitHub.

    Tests that want to exercise the real JWT/HTTP path (see
    test_github_app.py) opt out by marking themselves with
    `@pytest.mark.real_github_app`.
    """
    if request.node.get_closest_marker("real_github_app"):
        yield
        return

    # Import lazily — vibe.github_app is only available once env is set above.
    from vibe.github_app import InstallationToken

    async def _stub(repo_full_name: str) -> InstallationToken:
        return InstallationToken(
            token=f"ghs_stub_for_{repo_full_name}", expires_at=9_999_999_999
        )

    # Patch BOTH locations — Python binds names at import time, so the
    # `from vibe.github_app import mint_installation_token` in sessions.py
    # needs its own patch.
    try:
        monkeypatch.setattr("vibe.github_app.mint_installation_token", _stub)
    except (AttributeError, ImportError):
        pass
    try:
        monkeypatch.setattr("vibe.sessions.mint_installation_token", _stub)
    except (AttributeError, ImportError):
        pass
    try:
        monkeypatch.setattr("vibe.repo_files.mint_installation_token", _stub)
    except (AttributeError, ImportError):
        pass
    yield


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "real_github_app: opt OUT of the mint stub to exercise the real JWT path",
    )
