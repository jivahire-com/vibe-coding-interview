"""
Challenge-specific bonus (5% of composite).

Per-challenge scoring of decisions that don't generalise across challenges —
sync primitive choice, time source, const-correctness, etc. The scaffold
dispatches on `challenge_id`; new challenges add a function and a dispatch
entry. Unknown challenges return 5.0 with reasoning ("no per-challenge
criteria configured") so the composite stays stable as new challenges land.

The signals are surfaced as boolean / categorical evidence rather than full
LLM-style narrative — recruiters get a quick read on whether the candidate
made the right small calls.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

DEFAULT_SCORE = 5.0


def compute(challenge_id: str, clone_dir: Path, rubric: dict[str, Any]) -> dict[str, Any]:
    """Dispatch to a per-challenge scorer. Returns {score, breakdown}."""
    handler = _DISPATCH.get(challenge_id, _default_score)
    return handler(clone_dir, rubric)


def _default_score(_clone_dir: Path, _rubric: dict[str, Any]) -> dict[str, Any]:
    return {
        "score": DEFAULT_SCORE,
        "breakdown": {"reason": "no per-challenge criteria configured for this challenge"},
    }


# ─── python-ttl-cache ────────────────────────────────────────────────────────


def _python_ttl_cache(clone_dir: Path, rubric: dict[str, Any]) -> dict[str, Any]:
    source = _read_submission(clone_dir, rubric, default="src/ttl_cache.py")
    if source is None:
        return _default_score(clone_dir, rubric)

    criteria: dict[str, dict[str, Any]] = {}

    # 1. Synchronisation primitive — threading.Lock is the right default for
    #    non-recursive critical sections. RLock costs more and signals the
    #    candidate didn't think about whether recursive entry is needed.
    has_lock = bool(re.search(r"\bthreading\.Lock\s*\(", source))
    has_rlock = bool(re.search(r"\bthreading\.RLock\s*\(", source))
    if has_lock and not has_rlock:
        prim_score, prim_reason = 9.0, "uses threading.Lock — correct default for non-recursive locking"
    elif has_rlock:
        prim_score, prim_reason = 6.0, "uses RLock — overkill unless recursive entry is required"
    elif has_lock:
        prim_score, prim_reason = 8.0, "uses Lock (with some RLock fallback)"
    else:
        prim_score, prim_reason = 2.0, "no threading.Lock or RLock found — likely no synchronisation"
    criteria["sync_primitive"] = {"score": prim_score, "reason": prim_reason,
                                   "has_lock": has_lock, "has_rlock": has_rlock}

    # 2. Monotonic time source — time.time() is wall-clock and goes backwards
    #    on NTP correction; time.monotonic() is the right call for TTLs.
    uses_monotonic = bool(re.search(r"\btime\.monotonic\s*\(", source))
    uses_wallclock = bool(re.search(r"\btime\.time\s*\(", source))
    if uses_monotonic and not uses_wallclock:
        mono_score, mono_reason = 9.0, "uses time.monotonic — clock-skew-safe"
    elif uses_monotonic:
        mono_score, mono_reason = 7.0, "uses time.monotonic but also references time.time"
    elif uses_wallclock:
        mono_score, mono_reason = 3.0, "uses time.time — vulnerable to wall-clock jumps"
    else:
        mono_score, mono_reason = 5.0, "no explicit time source detected"
    criteria["time_source"] = {"score": mono_score, "reason": mono_reason,
                                "uses_monotonic": uses_monotonic,
                                "uses_wallclock": uses_wallclock}

    # 3. TTL-on-read strategy — get() must check expiry inline (lazy) or a
    #    background sweeper must purge before the next get; lazy is simpler.
    has_lazy_check = _has_lazy_ttl_check(source)
    if has_lazy_check:
        ttl_score, ttl_reason = 9.0, "get() contains a TTL-vs-elapsed check — lazy expiry implemented"
    else:
        ttl_score, ttl_reason = 4.0, "no obvious TTL check inside get() — expired entries may be returned"
    criteria["ttl_strategy"] = {"score": ttl_score, "reason": ttl_reason,
                                 "has_lazy_check": has_lazy_check}

    return _aggregate(criteria)


def _has_lazy_ttl_check(source: str) -> bool:
    """Heuristic: inside any get() definition, the function body subtracts a
    stored timestamp from time.monotonic()/time.time() and compares to ttl.
    """
    # Pull each get() body and look for a TTL comparison inside it.
    bodies = re.findall(
        r"def\s+get\s*\([^)]*\)[^:]*:\n(?P<body>(?:    .*\n|\t.*\n|\n)+)",
        source,
    )
    for body in bodies:
        if re.search(
            r"(time\.(monotonic|time)\s*\(\s*\)\s*-\s*\w+|"
            r"\w+\s*-\s*\w+\s*[<>]\s*\w*ttl|"
            r"\w+\s*>\s*\w+\s*\+\s*\w*ttl)",
            body,
        ):
            return True
    return False


# ─── cpp-lru-cache ───────────────────────────────────────────────────────────


def _cpp_lru_cache(clone_dir: Path, rubric: dict[str, Any]) -> dict[str, Any]:
    source = _read_submission(clone_dir, rubric, default="include/lru_cache.hpp")
    if source is None:
        return _default_score(clone_dir, rubric)

    criteria: dict[str, dict[str, Any]] = {}

    # 1. Synchronisation primitive — std::mutex is a fine default; shared_mutex
    #    is the more sophisticated choice for read-heavy workloads BUT the
    #    rubric notes that LRU is not naturally read-heavy (every get() also
    #    promotes the entry, requiring exclusive access). So shared_mutex
    #    without scoping reader-vs-writer correctly is actually worse.
    has_mutex = bool(re.search(r"\bstd::mutex\b", source))
    has_shared_mutex = bool(re.search(r"\bstd::shared_mutex\b", source))
    has_shared_lock = bool(re.search(r"\bstd::shared_lock\b", source))
    if has_shared_mutex and has_shared_lock:
        prim_score, prim_reason = 8.0, (
            "shared_mutex + shared_lock — correct read-heavy split (but check "
            "that get() still takes an exclusive lock for LRU promotion)"
        )
    elif has_shared_mutex and not has_shared_lock:
        prim_score, prim_reason = 5.0, (
            "shared_mutex declared but never used with shared_lock — defeats "
            "the purpose; exclusive lock-only path makes std::mutex simpler"
        )
    elif has_mutex:
        prim_score, prim_reason = 9.0, "std::mutex — correct default; LRU promotes on get()"
    else:
        prim_score, prim_reason = 2.0, "no std::mutex / std::shared_mutex found — likely no synchronisation"
    criteria["sync_primitive"] = {
        "score": prim_score, "reason": prim_reason,
        "has_mutex": has_mutex, "has_shared_mutex": has_shared_mutex,
        "has_shared_lock": has_shared_lock,
    }

    # 2. Const-correctness — size() and contains() are inspection methods and
    #    should be `const`. Locking inside a const method requires `mutable
    #    std::mutex`. Look for those markers.
    has_const_size = bool(re.search(r"\bsize\s*\([^)]*\)\s*const\b", source))
    has_mutable_mutex = bool(re.search(r"\bmutable\b[^;\n]*mutex", source))
    if has_const_size and has_mutable_mutex:
        const_score, const_reason = 9.0, "size()/contains() are const + mutex is mutable — clean"
    elif has_const_size and not has_mutable_mutex:
        const_score, const_reason = 6.0, "const inspection methods declared but mutex is not mutable — won't compile if locked"
    elif has_mutable_mutex:
        const_score, const_reason = 7.0, "mutable mutex present but inspection methods not const-qualified"
    else:
        const_score, const_reason = 4.0, "no const-qualified inspection methods detected"
    criteria["const_correctness"] = {
        "score": const_score, "reason": const_reason,
        "has_const_size": has_const_size,
        "has_mutable_mutex": has_mutable_mutex,
    }

    return _aggregate(criteria)


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _read_submission(clone_dir: Path, rubric: dict[str, Any], default: str) -> str | None:
    """Read the candidate's primary submission file. Returns None if missing."""
    files = rubric.get("submission_files") or [default]
    path = clone_dir / files[0]
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return None


def _aggregate(criteria: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Equal-weight average of per-criterion scores → dimension score."""
    if not criteria:
        return {"score": DEFAULT_SCORE, "breakdown": {"reason": "no criteria evaluated"}}
    avg = sum(c["score"] for c in criteria.values()) / len(criteria)
    return {
        "score": round(avg, 2),
        "breakdown": {"criteria": criteria},
    }


_DISPATCH = {
    "python-ttl-cache": _python_ttl_cache,
    "cpp-lru-cache": _cpp_lru_cache,
}
