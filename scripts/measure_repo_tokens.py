#!/usr/bin/env python3
"""Measure and cache repo token count for a challenge.

Usage:
    python scripts/measure_repo_tokens.py <challenge_id> [--model MODEL] [--force]
"""
import argparse
import os
import sys
from pathlib import Path

# Allow running from the repo root without installing the package
sys.path.insert(0, str(Path(__file__).parent.parent / "server"))

os.environ.setdefault("OPENAI_API_KEY", os.environ.get("OPENAI_API_KEY", ""))
os.environ.setdefault("GITHUB_BOT_PAT", "placeholder")
os.environ.setdefault("GITHUB_CHALLENGES_REPO", "placeholder/placeholder")
os.environ.setdefault("ADMIN_TOKEN", "placeholder")


def main() -> None:
    parser = argparse.ArgumentParser(description="Measure repo tokens for a challenge.")
    parser.add_argument("challenge_id", help="Challenge directory name under challenges/")
    parser.add_argument("--model", default=None, help="Model to use (default: from .env chat_model)")
    parser.add_argument("--force", action="store_true", help="Ignore cached result and re-measure")
    args = parser.parse_args()

    from vibe.config import settings
    from vibe.grader.repo_tokens import _CACHE_FILENAME, get_repo_tokens

    challenge_dir = Path(settings.challenges_dir) / args.challenge_id
    if not challenge_dir.is_dir():
        print(f"Error: challenge directory not found: {challenge_dir}", file=sys.stderr)
        sys.exit(1)

    model = args.model or settings.chat_model

    if args.force:
        cache_path = challenge_dir / ".jivahire" / _CACHE_FILENAME
        if cache_path.exists():
            cache_path.unlink()
            print(f"Removed cache file: {cache_path}")

    token_count = get_repo_tokens(challenge_dir, model)
    cache_path = challenge_dir / ".jivahire" / _CACHE_FILENAME
    print(f"repo_tokens: {token_count:,}")
    print(f"model: {model}")
    print(f"cache: {cache_path}")


if __name__ == "__main__":
    main()
