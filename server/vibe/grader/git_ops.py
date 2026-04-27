import subprocess
from pathlib import Path
from vibe.config import settings


def clone_branch(repo: str, branch: str, dest: Path) -> None:
    token = settings.github_bot_pat
    url = f"https://x-access-token:{token}@github.com/{repo}.git"
    subprocess.run(
        ["git", "clone", "--branch", branch, "--depth", "50", url, str(dest)],
        check=True,
        capture_output=True,
        timeout=60,
    )
