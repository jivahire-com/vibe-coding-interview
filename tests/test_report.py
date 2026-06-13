"""Tests for the Layer-3 report assembler (grader/report.py).

Verifies the single 0-100 scale (×10 done once here), the weighted-average total
over the applicable rubrics, N/A handling on the non-AI track, and that the
self-explanatory pieces (legend, Good/Bad yardstick, subpoint checks) ship in
the JSON.
"""
import os
import tempfile

os.environ.setdefault("OPENAI_API_KEY", "sk-test")
os.environ.setdefault("GITHUB_BOT_PAT", "ghp-test")
os.environ["GITHUB_CHALLENGES_OWNER"] = ""
os.environ.setdefault("GITHUB_CHALLENGES_REPO", "test-org/test-repo")
os.environ.setdefault("ADMIN_TOKEN", "admin-secret")
os.environ.setdefault("DB_PATH", tempfile.mkstemp(suffix=".db")[1])
os.environ.setdefault("LLM_BASE_URL", "https://openrouter.ai/api/v1")

from vibe.grader import report as R  # noqa: E402
from vibe.grader.signals import Signals  # noqa: E402

_VIBE_KEYS = ("tests", "traps", "code_quality", "architectural_reasoning",
              "challenge_specific", "verification_discipline", "ai_judgment",
              "llm_communication", "developer_signal")
_ENG_KEYS = ("tests", "traps", "code_quality", "architectural_reasoning",
             "challenge_specific", "verification_discipline", "developer_signal")


def _dims(score, *, ai=True):
    d = {k: {"score": score, "subpoints": [
        {"key": f"{k}_sp", "checks": "x", "verdict": "strong", "detail": "did well"}]}
        for k in _ENG_KEYS}
    if ai:
        d["ai_judgment"] = {"score": score, "subpoints": []}
        d["llm_communication"] = {"score": score, "subpoints": []}
    else:
        d["ai_judgment"] = {"score": None, "subpoints": []}
        d["llm_communication"] = {"score": None, "subpoints": []}
    return d


def _build(track, dims):
    return R.build_report(track, dims, Signals(ai_assistance=(track == "vibe")),
                          meta={"challenge": "c"}, bonuses=[],
                          telemetry_extra={"commits": 3, "protected_file_edits": 0})


def test_x10_done_once_and_weighted_total():
    rep = _build("vibe", _dims(8.0))
    # every applicable rubric is 8.0 ×10 = 80; weighted avg of all-80 = 80
    assert rep["overall"]["score"] == 80
    assert rep["overall"]["out_of"] == 100
    for sec in rep["sections"]:
        for r in sec["rubrics"]:
            if r["applies"]:
                assert r["score"] == 80


def test_band_thresholds():
    assert _build("vibe", _dims(8.0))["overall"]["band"] == "strong"   # 80
    assert _build("vibe", _dims(6.0))["overall"]["band"] == "mixed"    # 60
    assert _build("vibe", _dims(3.0))["overall"]["band"] == "weak"     # 30


def test_non_ai_marks_ai_rubrics_na_and_excludes_from_total():
    rep = _build("non_ai", _dims(8.0, ai=False))
    by_key = {r["key"]: r for sec in rep["sections"] for r in sec["rubrics"]}
    for k in ("ai_judgment", "llm_communication"):
        assert by_key[k]["applies"] is False
        assert by_key[k]["score"] is None
        assert by_key[k]["weight"] is None
        assert by_key[k]["na_reason"]
    # total is computed only from the 7 applicable engineering rubrics (all 80)
    assert rep["overall"]["score"] == 80


def test_every_rubric_present_both_tracks():
    vibe = {r["key"] for sec in _build("vibe", _dims(7.0))["sections"] for r in sec["rubrics"]}
    nonai = {r["key"] for sec in _build("non_ai", _dims(7.0, ai=False))["sections"] for r in sec["rubrics"]}
    assert set(_VIBE_KEYS) <= vibe
    assert set(_VIBE_KEYS) <= nonai  # AI rubrics still SHOWN on non-AI, just N/A


def test_self_explanatory_pieces_ship_in_json():
    rep = _build("vibe", _dims(7.0))
    assert len(rep["legend"]["verdicts"]) == 4
    a_rubric = rep["sections"][0]["rubrics"][0]
    assert a_rubric["good"] and a_rubric["bad"]
    assert a_rubric["subpoints"][0]["checks"]


def test_telemetry_catalogue_marks_vibe_rows_na_on_non_ai():
    rep = _build("non_ai", _dims(7.0, ai=False))
    vibe_rows = [t for t in rep["telemetry"] if t["track"] == "vibe"]
    assert vibe_rows and all(t["applies"] is False and t["value"] == "N/A" for t in vibe_rows)
    both_rows = [t for t in rep["telemetry"] if t["track"] == "both"]
    assert all(t["applies"] is True for t in both_rows)


def test_summary_points_present():
    rep = _build("vibe", _dims(7.0))
    pts = rep["overall"]["summary_points"]
    assert pts and "70 / 100" in pts[0]
