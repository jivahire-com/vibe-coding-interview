import datetime
import hashlib
import json
from pathlib import Path

from openai import OpenAI

from vibe.config import settings

_EXCLUDED_DIRS = {
    ".git", ".jivahire", "node_modules", "dist", "build", "target",
    "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache", ".tox",
    # CMake out-of-source build trees: these hold FetchContent-vendored
    # dependency *source* (e.g. Catch2 under _deps/) and generated text that
    # the binary-extension filter below does NOT catch. A single `build-tsan/`
    # dir blew the chat context past 3M tokens (model cap is 200k), which made
    # every chat request fail upstream with a 400 and surfaced as empty output.
    "_deps", "CMakeFiles", "cmake-build-debug", "cmake-build-release",
}
_EXCLUDED_EXTS = {
    ".lock", ".so", ".dll", ".exe", ".o", ".a", ".bin",
    ".zip", ".tar", ".gz", ".png", ".jpg", ".jpeg", ".gif", ".pdf",
}
# Skip any single file larger than this. A challenge's source is tiny; a file
# this big is a generated/vendored artifact that would bloat the context dump
# without helping the model answer.
_MAX_FILE_BYTES = 256 * 1024
_CACHE_FILENAME = "token_counts.json"
# Small fixed corrections to isolate the repo dump from system/ping overhead
_SYSTEM_OVERHEAD_TOKENS = 6
_PING_USER_MSG_TOKENS = 3


def get_repo_tokens(challenge_dir: Path, model: str) -> int:
    cache_path = challenge_dir / ".jivahire" / _CACHE_FILENAME
    current_hash = _content_hash(challenge_dir)

    if cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if cached.get("model") == model and cached.get("content_hash") == current_hash:
                return int(cached["repo_tokens"])
        except (json.JSONDecodeError, KeyError, ValueError):
            pass

    repo_tokens = _measure(challenge_dir, model)

    cache_data = {
        "model": model,
        "repo_tokens": repo_tokens,
        "content_hash": current_hash,
        "measured_on": datetime.date.today().isoformat(),
    }
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(cache_data, indent=2), encoding="utf-8")

    return repo_tokens


def _content_hash(challenge_dir: Path) -> str:
    h = hashlib.sha256()
    for file_path in sorted(_iter_files(challenge_dir)):
        rel = file_path.relative_to(challenge_dir)
        try:
            content = file_path.read_bytes()
            h.update(str(rel).encode())
            h.update(content)
        except OSError:
            pass
    return h.hexdigest()


def _measure(challenge_dir: Path, model: str) -> int:
    dump = _build_dump(challenge_dir)
    client = OpenAI(api_key=settings.openai_api_key, base_url=settings.llm_base_url)
    resp = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": dump},
            {"role": "user", "content": "ping"},
        ],
        max_tokens=1,
        temperature=0,
    )
    total = resp.usage.prompt_tokens
    return max(0, total - _SYSTEM_OVERHEAD_TOKENS - _PING_USER_MSG_TOKENS)


def _build_dump(challenge_dir: Path) -> str:
    parts = []
    for file_path in sorted(_iter_files(challenge_dir)):
        rel = file_path.relative_to(challenge_dir)
        try:
            content = file_path.read_text(encoding="utf-8")
            parts.append(f"// ===== {rel} =====\n{content}\n")
        except (UnicodeDecodeError, OSError):
            pass
    return "\n".join(parts)


def _iter_files(challenge_dir: Path):
    cache_path = challenge_dir / ".jivahire" / _CACHE_FILENAME
    for file_path in challenge_dir.rglob("*"):
        if not file_path.is_file():
            continue
        # Skip the cache file itself so content hash stays stable
        if file_path == cache_path:
            continue
        rel_parts = file_path.relative_to(challenge_dir).parts
        # Exclude named build/cache dirs plus any out-of-source CMake build
        # tree (`build`, `build-tsan`, `build-asan`, `build_debug`, …).
        if any(
            part in _EXCLUDED_DIRS or part.startswith("build-") or part.startswith("build_")
            for part in rel_parts
        ):
            continue
        name = file_path.name
        if name.endswith(".tar.gz"):
            continue
        if file_path.suffix.lower() in _EXCLUDED_EXTS:
            continue
        try:
            if file_path.stat().st_size > _MAX_FILE_BYTES:
                continue
        except OSError:
            continue
        yield file_path
