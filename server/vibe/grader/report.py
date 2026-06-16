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
    summary = _summary_points(total, band, track, scored, bonuses or [])

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
        "overall": {"score": total, "out_of": 100, "band": band, "summary_points": summary},
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


def _summary_points(total, band, track, scored, bonuses) -> list[str]:
    label = TRACK_LABEL.get(track, track)
    band_label = _BAND_LABEL.get(band, band)
    article = "an" if band_label[:1].lower() in "aeiou" else "a"
    points = [f"{total} / 100 overall — {article} {band_label} result on the {label.lower()} track."]
    if scored:
        lifters = sorted(scored, key=_contribution, reverse=True)[:2]
        gaps = sorted(scored, key=_gap, reverse=True)[:2]
        lifted = "; ".join(f"{e['label']} ({e['score']}/100 — {_best_reason(e)})" for e in lifters)
        held = "; ".join(f"{e['label']} ({e['score']}/100 — {_worst_reason(e)})" for e in gaps)
        points.append(f"What lifted it: {lifted}.")
        points.append(f"What held it back: {held}.")
    earned = [b for b in bonuses if b.get("attempted")]
    if earned:
        names = " and ".join(b.get("title", "bonus").lower() for b in earned)
        points.append(f"Bonuses earned: the {names} are already reflected in the scores above.")
    return points


def _best_reason(e: dict[str, Any]) -> str:
    for sp in e.get("subpoints", []):
        if sp.get("verdict") == "strong" and sp.get("detail"):
            return sp["detail"]
    return "scored well"


def _worst_reason(e: dict[str, Any]) -> str:
    for verdict in ("missing", "weak"):
        for sp in e.get("subpoints", []):
            if sp.get("verdict") == verdict and sp.get("detail"):
                return sp["detail"]
    return "lost ground against its weight"


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
