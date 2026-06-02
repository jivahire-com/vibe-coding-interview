"""Developer-confidence behavioral signal.

Computes a 0–100 score indicating how strongly the candidate behaved like a
practicing developer in the editor. Per Section 7.6 of the interview plan, this
score is **not** included in the composite grade — it is a separate signal
shown on the recruiter dashboard.

Signals are split into:
  Base (max 75 pts) — always scored; presence and quality both count.
  Bonus (max 25 pts; today only +15) — presence-only, never penalizing absence.

The two goto_definition / find_references bonus signals are reserved for a
future iteration (the extension does not emit them yet); they appear in the
returned `signals` dict as False for forward-compatibility.
"""
from __future__ import annotations

import json
from typing import Any

from openai import OpenAI

from vibe.db import query
from vibe.grader.llm_eval import _commentary_call

_CODE_KEYWORDS = (
    "function", "variable", "line", "error", "type", "return",
    "parameter", "import", "async", "null", "index", "array",
    "object", "class", "method", "callback", "promise",
)

# Aligned to the extension's POST_APPLY_WINDOW_MS (telemetry.ts) so the grader
# considers exactly the same edits the extension tagged with `post_apply_of`.
# Previously this was 60s while the extension carried tags for 90s; the 30s
# gap silently dropped legitimate post-apply edits from the modified-ratio.
_POST_AI_EDIT_WINDOW_MS = 90_000


def compute_developer_confidence(session_id: str, client: OpenAI) -> dict[str, Any]:
    events = _load_events(session_id)
    chat_prompts = _load_chat_prompts(session_id)

    signals: dict[str, Any] = {}

    files_opened = {
        e["payload"].get("file")
        for e in events
        if e["event_type"] == "file_open" and e["payload"].get("file")
    }
    signals["files_explored"] = len(files_opened)
    signals["files_explored_list"] = sorted(files_opened)

    # Time-spent per file from file_focus events emitted by the extension on
    # editor switch / window unfocus / dispose. A file with an open event but
    # no focus events (e.g. flipped past too fast for the listener to fire) is
    # still surfaced with 0 ms so the recruiter sees the full set.
    file_time_ms: dict[str, int] = {f: 0 for f in files_opened if f}
    for e in events:
        if e["event_type"] != "file_focus":
            continue
        f = e["payload"].get("file")
        ms = e["payload"].get("ms")
        if not f or not isinstance(ms, (int, float)) or ms <= 0:
            continue
        file_time_ms[f] = file_time_ms.get(f, 0) + int(ms)
    signals["files_explored_detail"] = [
        {"file": f, "ms": ms}
        for f, ms in sorted(file_time_ms.items(), key=lambda kv: (-kv[1], kv[0]))
    ]

    ai_inserts = [e for e in events if e["event_type"] == "edit_ai_applied"]
    typed = [e for e in events if e["event_type"] == "edit_typed"]
    # Char-weighted so the ratio reflects the FRACTION of AI output that the
    # candidate reworked, not whether *any* keystroke followed an apply. The
    # prior count-of-events formula reported 100% when a candidate typed a
    # single comment after a 1,600-char AI apply — flagged in production by
    # RAH-144. Each typed event counts at most once across all eligible
    # applies on the same file.
    ai_chars_total = sum(
        int(ai["payload"].get("chars") or 0) for ai in ai_inserts
    )
    apply_ts_by_file: dict[str, list[int]] = {}
    for ai_e in ai_inserts:
        f = ai_e["payload"].get("file")
        if f is None:
            continue
        apply_ts_by_file.setdefault(f, []).append(ai_e["ts"])

    post_typed_chars = 0
    for t_e in typed:
        chars = int(t_e["payload"].get("chars") or 0)
        if chars <= 0:
            continue
        for ai_ts in apply_ts_by_file.get(t_e["payload"].get("file"), ()):
            dt = t_e["ts"] - ai_ts
            if 0 < dt < _POST_AI_EDIT_WINDOW_MS:
                post_typed_chars += chars
                break

    if ai_chars_total > 0:
        signals["ai_output_modified_ratio"] = round(
            min(post_typed_chars / ai_chars_total, 1.0), 2
        )
    else:
        signals["ai_output_modified_ratio"] = 0

    if chat_prompts:
        with_terms = sum(
            1 for p in chat_prompts
            if any(kw in p.lower() for kw in _CODE_KEYWORDS)
        )
        signals["prompt_specificity"] = round(with_terms / len(chat_prompts), 2)
    else:
        signals["prompt_specificity"] = None

    signals["test_runs"] = sum(1 for e in events if e["event_type"] == "test_run")

    # Terminal-command kinds (npm install, cmake --build, pytest, …) emitted by
    # the extension's shell-integration listener. The grader surfaces install /
    # build counts on the recruiter dashboard alongside test_runs so a recruiter
    # can see whether the candidate exercised a realistic build/test loop.
    terminal_events = [e for e in events if e["event_type"] == "terminal_command"]
    signals["install_runs"] = sum(
        1 for e in terminal_events if e["payload"].get("kind") == "install"
    )
    signals["build_runs"] = sum(
        1 for e in terminal_events if e["payload"].get("kind") == "build"
    )

    base_score = (
        min(signals["files_explored"] / 5, 1.0) * 15
        + signals["ai_output_modified_ratio"] * 20
        + (signals["prompt_specificity"] or 0) * 30
        + min(signals["test_runs"] / 3, 1.0) * 10
    )

    signals["used_debugger"] = any(e["event_type"] == "debug_session" for e in events)
    # Reserved for follow-up: emitted by extension once provider wrappers land.
    signals["used_goto_definition"] = False
    signals["used_find_references"] = False

    bonus = 0
    if signals["used_debugger"]:
        bonus += 15
    if signals["used_goto_definition"]:
        bonus += 5
    if signals["used_find_references"]:
        bonus += 5

    score = min(round(base_score + bonus), 100)

    if score >= 60:
        verdict = "developer"
    elif score >= 35:
        verdict = "uncertain"
    else:
        verdict = "non_developer"

    reasoning = _build_reasoning(client, score, verdict, signals, session_id)

    return {
        "score": score,
        "verdict": verdict,
        "base_score": round(base_score),
        "bonus_score": bonus,
        "signals": signals,
        "reasoning": reasoning,
    }


def _load_events(session_id: str) -> list[dict[str, Any]]:
    rows = query(
        "SELECT ts, event_type, payload FROM telemetry WHERE session_id=? ORDER BY ts",
        (session_id,),
    )
    out = []
    for r in rows:
        try:
            payload = json.loads(r["payload"]) if isinstance(r["payload"], str) else (r["payload"] or {})
        except Exception:
            payload = {}
        out.append({"ts": r["ts"], "event_type": r["event_type"], "payload": payload})
    return out


def _load_chat_prompts(session_id: str) -> list[str]:
    rows = query(
        "SELECT prompt_text FROM chat_exchanges WHERE session_id=? AND prompt_text IS NOT NULL",
        (session_id,),
    )
    return [r["prompt_text"] for r in rows if r["prompt_text"]]


def _build_reasoning(client: OpenAI, score: int, verdict: str,
                      signals: dict, session_id: str) -> str:
    prompt = (
        "You are summarizing behavioral evidence about whether a candidate behaved "
        "like a practicing developer during a coding interview. Write 1-2 plain "
        "sentences explaining the verdict from the signals below. Do not invent "
        "facts; only describe what the signals show. Do not output a score.\n\n"
        f"Verdict: {verdict} (score {score}/100)\n"
        f"Files explored: {signals['files_explored']}\n"
        f"Fraction of AI-applied chars reworked by typing within 90s: {signals['ai_output_modified_ratio']}\n"
        f"Fraction of chat prompts using code-specific terms: {signals['prompt_specificity']}\n"
        f"Test runs: {signals['test_runs']}\n"
        f"Used debugger: {signals['used_debugger']}\n"
    )
    return _commentary_call(
        client, prompt,
        fallback=f"Behavioral signal: {verdict} ({score}/100).",
        session_id=session_id,
    )
