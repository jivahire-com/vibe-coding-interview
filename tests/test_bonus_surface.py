"""Tests for the product-sense bonus (grader/challenge_specific.product_sense_bonus).

The bonus LIFTS architectural reasoning and is never a penalty: not attempting
it returns boost 0 with attempted=False; attempting it returns a small boost and
the four strong/weak/missing subpoints (real_need, justified_choice, thread_safe,
proven_by_tests).
"""
import os
import tempfile
from pathlib import Path

os.environ.setdefault("OPENAI_API_KEY", "sk-test")
os.environ.setdefault("GITHUB_BOT_PAT", "ghp-test")
os.environ["GITHUB_CHALLENGES_OWNER"] = ""
os.environ.setdefault("GITHUB_CHALLENGES_REPO", "test-org/test-repo")
os.environ.setdefault("ADMIN_TOKEN", "admin-secret")
os.environ.setdefault("DB_PATH", tempfile.mkstemp(suffix=".db")[1])
os.environ.setdefault("LLM_BASE_URL", "https://openrouter.ai/api/v1")

from vibe.grader import challenge_specific  # noqa: E402

_RUBRIC = {"submission_files": ["include/lru_cache.hpp"]}
_PLAIN = "template <class K, class V> class LRUCache { };\n"


def _cpp(td: str, body: str, notes: str | None = None):
    inc = Path(td) / "include"
    inc.mkdir()
    (inc / "lru_cache.hpp").write_text(body)
    if notes is not None:
        (Path(td) / "NOTES.md").write_text(notes)
    return challenge_specific.product_sense_bonus(Path(td), _RUBRIC, design_why=None)


def test_not_attempted_is_zero_boost_no_penalty():
    with tempfile.TemporaryDirectory() as td:
        out = _cpp(td, _PLAIN)
    assert out["boost"] == 0.0
    assert out["card"]["attempted"] is False
    assert out["card"]["lifts"] == "architectural reasoning"
    assert out["card"]["subpoints"] == []


def test_attempted_lifts_and_emits_four_subpoints():
    body = _PLAIN + "#include <atomic>\nstruct Stats { std::atomic<long> hit_count{0}; };\n"
    with tempfile.TemporaryDirectory() as td:
        out = _cpp(td, body, notes="W" * 250 + " because on-call needs it; added a test.")
    assert out["boost"] > 0.0
    assert out["card"]["attempted"] is True
    keys = {sp["key"] for sp in out["card"]["subpoints"]}
    assert keys == {"real_need", "justified_choice", "thread_safe", "proven_by_tests"}
    assert all(sp["verdict"] in {"strong", "weak", "missing"} for sp in out["card"]["subpoints"])


def test_boost_is_capped():
    body = _PLAIN + "#include <atomic>\nstruct S { std::atomic<long> hit_count{0}; };\n"
    with tempfile.TemporaryDirectory() as td:
        out = _cpp(td, body, notes="W" * 400 + " because; instead; trade-off; test added")
    assert out["boost"] <= 1.0
