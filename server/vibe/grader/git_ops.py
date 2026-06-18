import asyncio
import subprocess
from pathlib import Path

from vibe.github_app import mint_installation_token

# The extension auto-commits all candidate work with an ``auto: <timestamp>``
# subject (see CLAUDE.md "Auto-Commit Audit Trail"). Every other commit on the
# branch — the starter import, the "update starter to canonical package" sync,
# the answer-key/​metadata provisioning — predates the candidate.
_AUTO_COMMIT_PREFIX = "auto:"


def candidate_base(clone_dir: Path) -> str | None:
    """SHA of the provisioning baseline: the newest commit the candidate did NOT
    author, i.e. the workspace handed to them before they started.

    Returned so callers can scope a diff/log to ``<base>..HEAD`` — the
    candidate's own commits only. Without this, setup commits (a 50+ line starter
    re-sync, the answer-key strip) read as candidate "code changes" and
    "recovery events". Returns ``None`` when no non-``auto:`` commit exists or git
    can't be read, so the caller can decide how to fall back rather than silently
    folding setup history back in.
    """
    try:
        out = subprocess.run(
            ["git", "-C", str(clone_dir), "log", "HEAD", "--pretty=%H%x00%s"],
            check=True, capture_output=True, text=True, timeout=30,
        ).stdout
    except Exception:
        return None
    for line in out.splitlines():
        sha, _, subject = line.partition("\x00")
        if not subject.startswith(_AUTO_COMMIT_PREFIX):
            return sha
    return None


def clone_branch(repo: str, branch: str, dest: Path) -> None:
    # Grader runs in a sync Celery worker, but mint_installation_token is
    # async (it talks to GitHub over httpx.AsyncClient). asyncio.run is fine
    # here — one short call, no event loop already running in this worker.
    token = asyncio.run(mint_installation_token(repo))
    url = f"https://x-access-token:{token.token}@github.com/{repo}.git"
    subprocess.run(
        ["git", "clone", "--branch", branch, "--depth", "50", url, str(dest)],
        check=True,
        capture_output=True,
        timeout=60,
    )
