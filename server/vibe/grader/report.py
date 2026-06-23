"""
Layer 3 — report assembler (GRADING_METRICS_MAP.md §4 + §5).

Takes the rubric results (each a holistic 1-10 score + strong/weak/missing
subpoints), the Layer-2 signals, and the bonus cards, and produces ONE
structured report object — the exact shape `dummy_grading_report.html` consumes.

This is where the single 0-100 scale is produced: every rubric's 1-10 is
multiplied by 10 **once**, here, and the overall total is the weight-weighted
average over the rubrics that apply to the track (N/A rubrics dropped from the
denominator). The page receives final numbers and does no arithmetic.

The report carries everything needed to render without this document: the
legend, each rubric's Good/Bad yardstick, every subpoint's "what it checks"
text, the bonuses, and the full telemetry catalogue (vibe-only rows marked N/A
on the non-AI track).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_CONFIG_PATH = Path(__file__).parent.parent / "grading_config.json"


def _config() -> dict[str, Any]:
    try:
        return json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"weights": {}, "rubrics": {}}


CONFIG = _config()

TRACK_LABEL = {"vibe": "Vibe coding", "non_ai": "Non-AI coding"}

# Overall-score bands — the single source of truth for the 0-100 verdict scale.
# Ordered high→low; `min` is inclusive, `max` is the inclusive display ceiling.
# `_band()` resolves a score to a key; the legend/score-ranges in the report JSON
# are derived from this same list, so the API and any UI never drift apart.
_BANDS = [
    {"key": "outstanding", "label": "Outstanding", "min": 90, "max": 100},
    {"key": "good",        "label": "Good",        "min": 70, "max": 89.99},
    {"key": "acceptable",  "label": "Acceptable",  "min": 50, "max": 69.99},
    {"key": "weak",        "label": "Weak",        "min": 30, "max": 49.99},
    {"key": "reject",      "label": "Reject",      "min": 0,  "max": 29.99},
]
_BAND_LABEL = {b["key"]: b["label"] for b in _BANDS}


def _band_legend() -> list[dict[str, Any]]:
    """Score-ranges legend (ascending, Reject→Outstanding) for the report JSON."""
    out = []
    for b in reversed(_BANDS):
        out.append({
            "key": b["key"],
            "label": b["label"],
            "min": b["min"],
            "max": b["max"],
            "range": f"{b['min']} – {b['max']}",
            "definition": f"Overall score {b['min']} – {b['max']}.",
        })
    return out


_LEGEND = {
    "verdicts": [
        {"key": "strong", "label": "Strong", "definition": "Done well."},
        {"key": "weak", "label": "Weak", "definition": "Partially done, or with gaps."},
        {"key": "missing", "label": "Missing", "definition": "Applies to this track, but not done."},
        {"key": "na", "label": "N/A",
         "definition": "Does not apply to this track — not scored, not counted."},
    ],
    "bands": _band_legend(),
}

_SECTIONS = {
    "engineering": {
        "title": "Engineering",
        "subtitle": "The core engineering set — judged on every submission, both tracks.",
    },
    "ai_collaboration": {
        "title": "AI collaboration",
        "subtitle": "How well the candidate worked with the AI — scored on the vibe-coding track only.",
    },
}

_NA_REASON = {
    "ai_judgment": "No AI assistant was used on this track, so there is no AI output to judge.",
    "llm_communication": "No AI assistant was used on this track, so there is no prompting to score.",
}


def build_report(
    track: str,
    dims: dict[str, dict[str, Any]],
    signals: Any,
    *,
    meta: dict[str, Any],
    bonuses: list[dict[str, Any]] | None = None,
    telemetry_extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    weights = CONFIG.get("weights", {}).get(track, {})
    rubric_cfg = CONFIG.get("rubrics", {})

    sections: dict[str, list[dict[str, Any]]] = {"engineering": [], "ai_collaboration": []}
    scored: list[dict[str, Any]] = []  # applicable rubrics, for the total + summary

    for key, cfg in rubric_cfg.items():
        section = cfg.get("section", "engineering")
        applies = section != "ai_collaboration" or track == "vibe"
        result = dims.get(key, {})
        entry = _rubric_entry(key, cfg, result, weights.get(key), track, applies)
        sections[section].append(entry)
        if applies and entry["score"] is not None:
            scored.append(entry)

    total = _weighted_total(scored)
    band = _band(total)
    factors = _factors(track, dims, signals, meta, total=total, band=band, scored=scored)

    section_list = []
    for sec_id, items in sections.items():
        if not items:
            continue
        meta_sec = _SECTIONS[sec_id]
        subtitle = meta_sec["subtitle"]
        if sec_id == "ai_collaboration" and track != "vibe":
            subtitle = "How well the candidate worked with the AI — does not apply to the non-AI track."
        section_list.append({"id": sec_id, "title": meta_sec["title"],
                             "subtitle": subtitle, "rubrics": items})

    return {
        "meta": meta,
        "legend": _LEGEND,
        "track": track,
        "track_label": TRACK_LABEL.get(track, track),
        "overall": {"score": total, "out_of": 100, "band": band, "factors": factors},
        "sections": section_list,
        "bonuses": bonuses or [],
        "telemetry": _telemetry_catalogue(signals, track, telemetry_extra or {}),
    }


# ─── Rubric entry ────────────────────────────────────────────────────────────


def _rubric_entry(key, cfg, result, weight, track, applies) -> dict[str, Any]:
    raw = result.get("score")
    score_0_100 = round(raw * 10) if (applies and raw is not None) else None
    entry = {
        "key": key,
        "title": cfg.get("title", key),
        "label": cfg.get("label", key),
        "kind": cfg.get("kind", "deterministic"),
        "applies": applies,
        "score": score_0_100,
        "out_of": 100,
        "weight": weight if applies else None,
        "good": cfg.get("good", ""),
        "bad": cfg.get("bad", ""),
        "subpoints": result.get("subpoints", []) if applies else _na_subpoints(result),
    }
    if applies:
        if result.get("note"):
            entry["note"] = result["note"]
        if result.get("verdict_label"):
            entry["verdict_label"] = result["verdict_label"]
    else:
        entry["na_reason"] = _NA_REASON.get(key, "Does not apply to this track.")
    return entry


def _na_subpoints(result) -> list[dict[str, Any]]:
    return [
        {"key": sp.get("key"), "checks": sp.get("checks"), "verdict": "na", "detail": ""}
        for sp in result.get("subpoints", [])
    ]


# ─── Total + band + summary (§4) ─────────────────────────────────────────────


def _weighted_total(scored: list[dict[str, Any]]) -> int:
    denom = sum(e["weight"] for e in scored if e["weight"])
    if not denom:
        return 0
    return round(sum(e["score"] * e["weight"] for e in scored) / denom)


def _band(total: float) -> str:
    for b in _BANDS:  # high→low; first whose floor the score clears wins
        if total >= b["min"]:
            return b["key"]
    return _BANDS[-1]["key"]


def _contribution(e: dict[str, Any]) -> float:
    return (e["score"] / 100.0) * (e["weight"] or 0)


def _gap(e: dict[str, Any]) -> float:
    return (e["weight"] or 0) - _contribution(e)


# ─── Recruiter factors (overall.factors) ─────────────────────────────────────
#
# Plain-language, recruiter-facing checks shown at the top of the report. Each is
# a single card with a green/red flag (`status`), a short headline (`summary`),
# and a one-line plain-English `description`. A non-technical recruiter should be
# able to skim these and decide whether to move the candidate forward.
#
# `status` is "good" (green) or "bad" (red). The review-alerts card carries an
# `items` list so multiple alerts can each render on their own line.

# A 0-100 rubric score at or above this counts as a green flag (the "Acceptable"
# band floor — see _BANDS). Below it is a red flag.
_FACTOR_PASS_100 = 50


def _factors(track, dims, signals, meta, *, total, band, scored) -> list[dict[str, Any]]:
    factors = [
        _overall_factor(total, band, scored),
        _tests_factor(dims.get("tests", {}), meta),
        _code_quality_factor(dims.get("code_quality", {})),
        _readme_factor(signals),
        _review_alerts_factor(dims, meta),
        _compiled_factor(meta),
    ]
    if meta.get("ai_assistance"):
        factors.append(_ai_collaboration_factor(dims.get("llm_communication", {})))
    return factors


def _overall_factor(total: int, band: str, scored: list[dict[str, Any]]) -> dict[str, Any]:
    """The headline verdict — recast from the old `summary_points`. Plain words:
    the score, a green/red call, and the candidate's strongest and weakest area."""
    band_label = _BAND_LABEL.get(band, band)
    status = "good" if total >= _FACTOR_PASS_100 else "bad"
    lead = ("Strong enough to move forward." if status == "good"
            else "Not strong enough to move forward.")
    strengths = _strength_and_gap(scored)
    description = f"{lead} {strengths}".strip()
    return {"key": "overall", "label": "Overall result", "status": status,
            "summary": f"{total}/100 — {band_label}", "description": description}


def _strength_and_gap(scored: list[dict[str, Any]]) -> str:
    if not scored:
        return ""
    best = max(scored, key=_contribution)
    worst = max(scored, key=_gap)
    parts = [f"Strongest on {best['label'].lower()}"]
    if worst is not best:
        parts.append(f"weakest on {worst['label'].lower()}")
    return "; ".join(parts) + "."


def _dim_score_100(dim: dict[str, Any]) -> int | None:
    raw = dim.get("score")
    return round(raw * 10) if isinstance(raw, (int, float)) else None


def _tests_factor(tests_dim: dict[str, Any], meta: dict[str, Any]) -> dict[str, Any]:
    subs = tests_dim.get("subpoints", []) or []
    if meta.get("build_failed"):
        items = [f"{sp.get('key', 'test')} — not run (code did not compile)" for sp in subs]
        return {"key": "tests", "label": "Tests", "status": "bad",
                "summary": "Tests could not run", "items": items,
                "description": "The code did not compile, so no hidden tests ran."}
    total = len(subs)
    passed = sum(1 for sp in subs if sp.get("verdict") == "strong")
    if total == 0:
        return {"key": "tests", "label": "Tests", "status": "bad",
                "summary": "No tests ran", "items": [],
                "description": "No hidden tests were run on this submission."}
    items = [f"{sp.get('key', 'test')} — {'passed' if sp.get('verdict') == 'strong' else 'failed'}"
             for sp in subs]
    status = "good" if passed == total else "bad"
    description = ("All hidden tests passed." if status == "good"
                  else f"{total - passed} of {total} hidden tests failed.")
    return {"key": "tests", "label": "Tests", "status": status,
            "summary": f"{passed}/{total} hidden tests passed", "items": items,
            "description": description}


def _code_quality_factor(cq_dim: dict[str, Any]) -> dict[str, Any]:
    score = _dim_score_100(cq_dim)
    if score is None:
        return {"key": "code_quality", "label": "Does the code work", "status": "bad",
                "summary": "Could not assess",
                "description": "We could not assess whether the code works."}
    status = "good" if score >= _FACTOR_PASS_100 else "bad"
    description = ("The code works and is cleanly written." if status == "good"
                  else "The code has clear problems or does not fully work.")
    return {"key": "code_quality", "label": "Does the code work", "status": status,
            "summary": f"Code quality {score}/100", "description": description}


def _readme_factor(signals: Any) -> dict[str, Any]:
    detail = getattr(signals, "files_explored_detail", []) or []
    ms = sum(d.get("ms", 0) for d in detail if "readme" in (d.get("file") or "").lower())
    secs = ms // 1000
    if secs <= 0:
        return {"key": "readme_time", "label": "Read the instructions", "status": "bad",
                "summary": "README not opened",
                "description": "Never opened the README — may not have read the task."}
    status = "good" if secs >= 60 else "bad"
    description = ("Took time to read the task before coding." if status == "good"
                  else "Barely read the task before starting — under a minute.")
    return {"key": "readme_time", "label": "Read the instructions", "status": status,
            "summary": f"Read README for {_fmt_ms(ms)}", "description": description}


def _review_alerts_factor(dims: dict[str, Any], meta: dict[str, Any]) -> dict[str, Any]:
    items: list[str] = []
    if meta.get("telemetry_tampered"):
        items.append("Telemetry tampering detected — the session record was altered, "
                     "so the signals below may not be trustworthy.")
    if meta.get("no_show"):
        items.append("Did not genuinely take part in the session.")
    if dims.get("developer_signal", {}).get("verdict_label") == "non_developer":
        items.append("Did not behave like a developer — did not build the project or "
                     "run the tests as a real developer would.")
    if items:
        noun = "thing" if len(items) == 1 else "things"
        return {"key": "review_alerts", "label": "Review alerts", "status": "bad",
                "summary": f"{len(items)} {noun} to check", "items": items,
                "description": "Things a reviewer should look at before deciding."}
    return {"key": "review_alerts", "label": "Review alerts", "status": "good",
            "summary": "All integrity checks passed", "items": [],
            "description": "Telemetry was intact, the candidate genuinely took part, "
                           "and they behaved like a developer — nothing for a reviewer "
                           "to double-check."}


def _compiled_factor(meta: dict[str, Any]) -> dict[str, Any]:
    failed = bool(meta.get("build_failed"))
    return {"key": "compiled", "label": "Code compiled",
            "status": "bad" if failed else "good",
            "summary": "Did not compile" if failed else "Compiled successfully",
            "description": ("The submitted code failed to build." if failed
                            else "The submitted code built without errors.")}


def _ai_collaboration_factor(comm_dim: dict[str, Any]) -> dict[str, Any]:
    score = _dim_score_100(comm_dim)
    if score is None:
        return {"key": "ai_collaboration", "label": "AI collaboration", "status": "bad",
                "summary": "Could not assess",
                "description": "We could not assess how the candidate worked with AI."}
    status = "good" if score >= _FACTOR_PASS_100 else "bad"
    description = ("Worked well with the AI assistant to build the solution." if status == "good"
                  else "Worked with the AI but the collaboration was weak.")
    return {"key": "ai_collaboration", "label": "AI collaboration", "status": status,
            "summary": f"AI teamwork {score}/100", "description": description}


# ─── Telemetry catalogue (§1) ────────────────────────────────────────────────


def _telemetry_catalogue(s: Any, track: str, extra: dict[str, Any]) -> list[dict[str, Any]]:
    vibe = track == "vibe"

    def row(name, source, trk, value, detail=""):
        applies = True if trk == "both" else vibe
        return {"name": name, "source": source, "track": trk, "applies": applies,
                "value": value if applies else "N/A",
                "detail": detail if applies else "no AI assistant on this track"}

    g = lambda attr, default=0: getattr(s, attr, default)
    files = g("files_explored")
    files_detail = ", ".join(d["file"] for d in g("files_explored_detail", [])[:5])
    total_ms = sum(d["ms"] for d in g("files_explored_detail", []))
    mod = g("modify_after_apply", {}) or {}

    return [
        row("Files explored", "file_open {file}", "both", f"{files} files", files_detail),
        row("Time on file", "file_focus {file, ms}", "both", _fmt_ms(total_ms)),
        row("Typed chars", "edit_typed {chars}", "both", f"{g('typed_chars'):,} chars",
            "hand-written code"),
        row("Pasted chars", "edit_pasted {chars, suspicious_paste}", "both",
            f"{g('pasted_chars'):,} chars", f"{g('suspicious_pastes')} suspicious"),
        row("Test run", "test_run / terminal_command {kind:test}", "both", f"{g('test_runs')} runs"),
        row("Build run", "terminal_command {kind:build}", "both", f"{g('build_runs')} builds"),
        row("Install run", "terminal_command {kind:install}", "both", f"{g('install_runs')} installs"),
        row("Debugger", "debug_session", "both",
            "used" if g("used_debugger", False) else "not used"),
        row("Window switch", "app_unfocused / app_focused {time_away_seconds}", "both",
            f"{g('window_switches')} switches"),
        row("Protected-file edit", "protected_file_edit", "both",
            str(extra.get("protected_file_edits", 0))),
        row("Commits / reverts", "auto_commit + git history", "both",
            f"{extra.get('commits', '—')} commits, {g('recovery_events', {}).get('count', 0)} reverts"),
        row("AI accepted", "edit_ai_applied {chars, block_id}", "vibe",
            f"{mod.get('applies', 0)} applies", f"{g('ai_applied_chars'):,} AI chars"),
        row("AI rejected", "edit_ai_rejected {block_id}", "vibe", f"{g('explicit_rejections')} rejected"),
        row("Post-apply edit", "post_apply_of tag", "vibe", f"{mod.get('reviewed', 0)} edits",
            "within 90s of accepting"),
        row("Chat exchange", "chat_exchanges {prompt_text, tokens, cost_usd}", "vibe",
            f"{g('num_chat_exchanges')} prompts", f"{g('total_chat_tokens'):,} tokens"),
    ]


def _fmt_ms(ms: int) -> str:
    if not ms:
        return "0s"
    secs = ms // 1000
    m, s = divmod(secs, 60)
    return f"{m}m {s:02d}s" if m else f"{s}s"
