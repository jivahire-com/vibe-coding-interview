import asyncio
import subprocess
from pathlib import Path

from vibe.github_app import mint_installation_token


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
