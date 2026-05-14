from pathlib import Path

from vibe.config import settings
from vibe.grader.repo_tokens import _build_dump

_cache: dict[str, str] = {}


def get_challenge_context(challenge_id: str) -> str:
    cached = _cache.get(challenge_id)
    if cached is not None:
        return cached

    challenge_dir = Path(settings.challenges_dir) / challenge_id
    if not challenge_dir.is_dir():
        _cache[challenge_id] = ""
        return ""

    dump = _build_dump(challenge_dir)
    _cache[challenge_id] = dump
    return dump


def clear_cache() -> None:
    _cache.clear()
