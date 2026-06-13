"""
Challenge-specific rubric (GRADING_METRICS_MAP.md §2A) + the product-sense bonus.

`score()` is a per-challenge static scan of the submitted code — the small,
non-generalising calls (sync primitive, time source, const-correctness). It
returns one holistic 1-10 plus strong/weak/missing subpoints. Unknown challenges
return a neutral 5.0 with no subpoints so the composite stays stable.

`product_sense_bonus()` is the optional "go further" bonus that LIFTS the
architectural-reasoning score (never its own /100 line, never a penalty). It
returns a report bonus card and a small `boost` (on the 1-10 arch scale) for the
runner to add to architectural reasoning.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from vibe.grader.rubric_common import verdict_from_score

DEFAULT_SCORE = 5.0
_MAX_PRODUCT_BOOST = 1.0  # on the 1-10 architectural-reasoning scale


# ─── Challenge-specific rubric ───────────────────────────────────────────────


def score(challenge_id: str, clone_dir: Path, rubric: dict[str, Any]) -> dict[str, Any]:
    handler = _DISPATCH.get(challenge_id)
    if handler is None:
        return {"score": DEFAULT_SCORE, "subpoints": [],
                "note": "No per-challenge criteria configured for this challenge."}
    return handler(clone_dir, rubric)


def _python_ttl_cache(clone_dir: Path, rubric: dict[str, Any]) -> dict[str, Any]:
    source = _read_submission(clone_dir, rubric, "src/ttl_cache.py")
    if source is None:
        return {"score": DEFAULT_SCORE, "subpoints": [], "note": "Submission file not found."}

    has_lock = bool(re.search(r"\bthreading\.Lock\s*\(", source))
    has_rlock = bool(re.search(r"\bthreading\.RLock\s*\(", source))
    if has_lock and not has_rlock:
        prim = (9.0, "Uses threading.Lock — correct default for non-recursive locking.")
    elif has_rlock:
        prim = (6.0, "Uses RLock — overkill unless recursive entry is required.")
    elif has_lock:
        prim = (8.0, "Uses Lock (with some RLock fallback).")
    else:
        prim = (2.0, "No threading.Lock or RLock found — likely no synchronisation.")

    uses_monotonic = bool(re.search(r"\btime\.monotonic\s*\(", source))
    uses_wall = bool(re.search(r"\btime\.time\s*\(", source))
    if uses_monotonic and not uses_wall:
        mono = (9.0, "Uses time.monotonic — clock-skew-safe.")
    elif uses_monotonic:
        mono = (7.0, "Uses time.monotonic but also references time.time.")
    elif uses_wall:
        mono = (3.0, "Uses time.time — vulnerable to wall-clock jumps.")
    else:
        mono = (5.0, "No explicit time source detected.")

    lazy = _has_lazy_ttl_check(source)
    ttl = (9.0, "get() contains a TTL-vs-elapsed check — lazy expiry implemented.") if lazy \
        else (4.0, "No obvious TTL check inside get() — expired entries may be returned.")

    parts = {"sync_primitive": (prim, "A real synchronisation primitive is present."),
             "time_source": (mono, "A monotonic time source is used for the TTL."),
             "ttl_strategy": (ttl, "Expiry is checked on read.")}
    return _aggregate(parts)


def _cpp_thread_safe_cache(clone_dir: Path, rubric: dict[str, Any]) -> dict[str, Any]:
    source = _read_submission(clone_dir, rubric, "include/lru_cache.hpp")
    if source is None:
        return {"score": DEFAULT_SCORE, "subpoints": [], "note": "Submission file not found."}

    has_mutex = bool(re.search(r"\bstd::mutex\b", source))
    has_shared_mutex = bool(re.search(r"\bstd::shared_mutex\b", source))
    has_shared_lock = bool(re.search(r"\bstd::shared_lock\b", source))
    if has_shared_mutex and has_shared_lock:
        prim = (2.5, "std::shared_mutex + std::shared_lock — fell for the read-heavy bait: "
                     "get() promotes via splice and mutates the list, so a shared_lock on it is a race.")
    elif has_mutex:
        prim = (9.0, "std::mutex — correct default; get() mutates (LRU promotion) so exclusive locking is right.")
    elif has_shared_mutex:
        prim = (7.0, "std::shared_mutex without std::shared_lock — exclusive-only is correct but pointless here.")
    else:
        prim = (2.0, "No std::mutex / std::shared_mutex found — likely no synchronisation.")

    has_const_size = bool(re.search(r"\bsize\s*\([^)]*\)\s*const\b", source))
    has_mutable_mutex = bool(re.search(r"\bmutable\b[^;\n]*mutex", source))
    if has_const_size and has_mutable_mutex:
        const = (9.0, "size()/contains() are const + mutex is mutable — clean.")
    elif has_const_size:
        const = (6.0, "const inspection methods declared but mutex is not mutable — won't compile if locked.")
    elif has_mutable_mutex:
        const = (7.0, "mutable mutex present but inspection methods not const-qualified.")
    else:
        const = (4.0, "No const-qualified inspection methods detected.")

    parts = {"sync_primitive": (prim, "A real synchronisation primitive is present."),
             "const_correctness": (const, "Locking stays const-correct.")}
    return _aggregate(parts)


def _aggregate(parts: dict[str, tuple[tuple[float, str], str]]) -> dict[str, Any]:
    subs = []
    total = 0.0
    for key, ((sc, detail), checks) in parts.items():
        subs.append({"key": key, "checks": checks,
                     "verdict": verdict_from_score(sc), "detail": detail})
        total += sc
    avg = total / len(parts) if parts else DEFAULT_SCORE
    return {"score": round(avg, 2), "subpoints": subs, "note": None}


def _has_lazy_ttl_check(source: str) -> bool:
    bodies = re.findall(
        r"def\s+get\s*\([^)]*\)[^:]*:\n(?P<body>(?:    .*\n|\t.*\n|\n)+)", source)
    for body in bodies:
        if re.search(
            r"(time\.(monotonic|time)\s*\(\s*\)\s*-\s*\w+|"
            r"\w+\s*-\s*\w+\s*[<>]\s*\w*ttl|\w+\s*>\s*\w+\s*\+\s*\w*ttl)", body):
            return True
    return False


# ─── Product-sense bonus (lifts architectural reasoning) ─────────────────────


def product_sense_bonus(clone_dir: Path, rubric: dict[str, Any],
                        design_why: str | None = None) -> dict[str, Any]:
    """Optional bonus → {card, boost}. `boost` is on the 1-10 arch scale."""
    source = _read_submission(clone_dir, rubric, "") or ""
    notes_path = clone_dir / "NOTES.md"
    try:
        notes = notes_path.read_text(encoding="utf-8") if notes_path.exists() else ""
    except OSError:
        notes = ""

    has_notes = len(notes.strip()) >= 200
    some_notes = bool(notes.strip())
    justified = bool(re.search(r"\b(because|instead|trade[- ]?off|chose|rather than)\b", notes, re.I)) \
        or bool(design_why and len(design_why) > 40)
    thread_safe = bool(re.search(r"\b(std::atomic|threading\.Lock|std::mutex|with\s+self\._?lock)\b", source))
    new_feature = bool(re.search(
        r"\b(hit|hits|miss|misses|hit_count|miss_count|on_evict|eviction_callback|"
        r"ttl|expire|expiry|stale|metric|observ)\w*", source, re.I))
    proven = bool(re.search(r"\btest", notes, re.I)) or new_feature
    attempted = has_notes or some_notes or new_feature

    real_need = 9.0 if has_notes else 5.0 if some_notes else None
    justified_sc = 9.0 if justified else 5.0 if some_notes else None
    thread_sc = 9.0 if thread_safe and new_feature else 6.0 if thread_safe else None
    proven_sc = 8.0 if proven else None

    def _sp(key, checks, sc, detail):
        return {"key": key, "checks": checks,
                "verdict": verdict_from_score(sc) if sc is not None else "missing",
                "detail": detail}

    subpoints = [
        _sp("real_need", "Identified a real user/operator need.", real_need,
            "NOTES.md describes a real need." if has_notes else
            "Some NOTES.md content." if some_notes else "No NOTES.md write-up."),
        _sp("justified_choice", "Explained why this over alternatives.", justified_sc,
            "Rationale present in NOTES.md / chat." if justified else "Little stated 'why'."),
        _sp("thread_safe", "Kept any new state safe under concurrency.", thread_sc,
            "New state is synchronised." if thread_safe else "No new synchronised state detected."),
        _sp("proven_by_tests", "Showed the new behaviour works with tests.", proven_sc,
            "New behaviour appears exercised." if proven else "No new tests detected."),
    ]

    boost = 0.0
    if has_notes:
        boost += 0.5
    if new_feature:
        boost += 0.25
    if thread_safe and new_feature:
        boost += 0.25
    boost = round(min(_MAX_PRODUCT_BOOST, boost), 2)

    note = ("Optional; lifts architectural reasoning, never subtracts."
            if attempted else
            "Not attempted — reported as an observation only, never a penalty.")
    card = {
        "key": "product_sense",
        "title": "Product-sense bonus",
        "attempted": attempted,
        "lifts": "architectural reasoning",
        "note": note,
        "subpoints": subpoints if attempted else [],
    }
    return {"card": card, "boost": boost if attempted else 0.0}


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _read_submission(clone_dir: Path, rubric: dict[str, Any], default: str) -> str | None:
    files = rubric.get("submission_files") or ([default] if default else [])
    if not files:
        return None
    try:
        return (clone_dir / files[0]).read_text(encoding="utf-8")
    except Exception:
        return None


_DISPATCH = {
    "python-ttl-cache": _python_ttl_cache,
    "cpp-thread-safe-cache": _cpp_thread_safe_cache,
}
