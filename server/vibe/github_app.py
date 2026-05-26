"""GitHub App authentication.

Mints short-lived, repo-scoped installation tokens. These replace the
long-lived `github_bot_pat` that used to be shipped to candidates in the
validate-session response — that token (a) lived forever, (b) had access to
every repo in the org, and (c) was visible to the candidate in `.git/config`
and in any git error message.

An installation token from this module:
  - expires in ~1 hour (GitHub-enforced)
  - is scoped to ONE repository (the candidate's challenge), so even if the
    candidate exfiltrates it they cannot touch other challenge repos
  - has the `ghs_` prefix — never confuse it with a personal access token
    (`ghp_*` or `github_pat_*`), which this module deliberately does not handle

The JWT signing key never leaves the server. The candidate only ever sees the
installation token returned by GitHub's `/access_tokens` endpoint.
"""

from __future__ import annotations

import datetime as _dt
import logging
import time
from dataclasses import dataclass

import httpx
import jwt

from vibe.config import settings

log = logging.getLogger("vibe.github_app")

# GitHub caps App JWTs at 10 minutes. We use ~9 to leave a buffer for clock
# skew between this server and GitHub's API; >10 → 401 from the access_tokens
# endpoint, which would surface to the candidate as a generic "could not start
# session" error.
_JWT_LIFETIME_SECONDS = 540

# Module-level cache for the parsed private key. Loading + parsing the PEM is
# done once on first use; subsequent calls reuse it. Cleared on test reset by
# rebinding `settings`.
_private_key_cache: bytes | None = None


@dataclass
class InstallationToken:
    token: str
    """The `ghs_*` installation token. Pass to clone/push via the existing
    `https://x-access-token:<token>@github.com/...` URL form."""

    expires_at: int
    """Expiration time as a Unix epoch second. The extension uses this to
    schedule a refresh shortly before expiry — sessions can run longer than
    one hour, so we cannot ship the validate-session token and forget it."""


def _normalize_private_key(raw: str) -> bytes:
    """Accept either a literal PEM block (with real newlines) or a single-line
    form where newlines have been replaced with the two-character `\\n`
    sequence. The latter is common in `.env` files that don't quote
    multi-line values.

    Returns the PEM as bytes — PyJWT/cryptography accepts both bytes and str
    but bytes is the unambiguous interface.
    """
    if "\\n" in raw and "\n" not in raw:
        raw = raw.replace("\\n", "\n")
    return raw.strip().encode("utf-8")


def _build_jwt() -> str:
    """Build the App-level JWT used to authenticate to the
    `/app/installations/.../access_tokens` endpoint. Signed RS256 with the
    App's private key; valid for ~9 minutes.
    """
    global _private_key_cache
    if _private_key_cache is None:
        if not settings.github_app_private_key:
            raise RuntimeError(
                "github_app_private_key is empty — set GITHUB_APP_PRIVATE_KEY in the server env"
            )
        _private_key_cache = _normalize_private_key(settings.github_app_private_key)
    now = int(time.time())
    payload = {
        # iat backdated 30s to absorb clock skew without exceeding the
        # GitHub-enforced 10-minute window.
        "iat": now - 30,
        "exp": now + _JWT_LIFETIME_SECONDS,
        # PyJWT >=2.10 enforces str for iss. GitHub accepts the App ID as a
        # numeric string ("424242") interchangeably with a JSON number, so
        # stringifying is safe and forward-compatible.
        "iss": str(settings.github_app_id),
    }
    return jwt.encode(payload, _private_key_cache, algorithm="RS256")


async def mint_installation_token(repo_full_name: str) -> InstallationToken:
    """Mint a fresh installation token scoped to a single repository.

    `repo_full_name` is the GitHub-canonical `<owner>/<repo>` form (the same
    string the rest of the server uses for `repo_for_challenge`). Only the
    `<repo>` half is sent to GitHub — the owner is implicit in the
    Installation ID — but we accept the full form so callers don't have to
    split it.

    Raises RuntimeError on a non-2xx response from GitHub. We deliberately do
    NOT raise HTTPException here so the same helper can be used from
    non-request contexts (e.g. an async refresh worker, future Celery tasks).
    Callers that want to surface 502 to the candidate should wrap this and
    translate.
    """
    if not settings.github_app_installation_id:
        raise RuntimeError(
            "github_app_installation_id is unset — server cannot mint clone tokens"
        )

    owner, sep, repo_short = repo_full_name.rpartition("/")
    if not sep or not owner or not repo_short:
        raise ValueError(f"repo_full_name must be '<owner>/<repo>', got {repo_full_name!r}")

    app_jwt = _build_jwt()
    headers = {
        "Authorization": f"Bearer {app_jwt}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    body = {
        # Scope the token to just this one repo. Defense-in-depth: even though
        # the App is installed only on selected repos, the *token* the
        # candidate receives only works for THEIR challenge — they cannot
        # poke around at other candidates' branches or other challenges.
        "repositories": [repo_short],
        # Smallest viable permission set for clone + push + branch create.
        # Must be a subset of what the App was created with (Contents R/W).
        "permissions": {"contents": "write"},
    }

    url = (
        f"https://api.github.com/app/installations/"
        f"{settings.github_app_installation_id}/access_tokens"
    )
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(url, headers=headers, json=body)
    if r.status_code != 201:
        # Don't echo the JWT or response headers; the body is enough to
        # diagnose (it contains GitHub's own error message, not our secrets).
        log.error(
            "github_app_mint_failed",
            extra={"context": {
                "status": r.status_code,
                "repo": repo_full_name,
                "body": r.text[:500],
            }},
        )
        raise RuntimeError(
            f"GitHub App: could not mint installation token "
            f"(status={r.status_code})"
        )

    data = r.json()
    expires_at_iso = data["expires_at"]  # e.g. "2026-05-25T12:34:56Z"
    # Parse GitHub's ISO-8601 timestamp into epoch seconds. fromisoformat in
    # Python 3.12 handles the trailing Z, but be explicit for older patches.
    if expires_at_iso.endswith("Z"):
        expires_at_iso = expires_at_iso[:-1] + "+00:00"
    expires_at = int(_dt.datetime.fromisoformat(expires_at_iso).timestamp())
    return InstallationToken(token=data["token"], expires_at=expires_at)


def _reset_cache_for_tests() -> None:
    """Clear the private-key cache so tests can rebind settings between
    cases. Not intended for production code paths."""
    global _private_key_cache
    _private_key_cache = None
