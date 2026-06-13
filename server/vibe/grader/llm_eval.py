"""
LLM-graded rubrics: Code Quality, Architectural Reasoning, LLM Communication.

Per GRADING_METRICS_MAP.md each evaluator now:
  1. Makes exactly ONE model call at temperature 0 (`self_consistency_n: 1` —
     self-consistency is off; at temp 0 repeated greedy decodes are near
     identical, so extra runs buy nothing).
  2. Returns ONE holistic 1-10 score for the dimension plus, per criterion, a
     plain-English `strong` / `weak` / `missing` verdict with 1-2 sentences of
     evidence — never a number per criterion (false precision).
  3. Uses the model + version pinned in `grading_config.json`.

Telemetry interpretation is NOT done here — it is a Layer-2 signal. This module
reads `signals.design_why` (injected into architectural reasoning) and
`signals.total_chat_tokens` (token discipline) rather than re-deriving anything.
The criteria are problem-neutral, so a new challenge/language changes only
`.jivahire/` data, never this prompt code.
"""

from __future__ import annotations

import json
import re
import time
import traceback
from pathlib import Path
from typing import Any

from openai import OpenAI

from vibe.config import settings
from vibe.db import query

_FALLBACK_SCORE = 5.0
_CONFIG_PATH = Path(__file__).parent.parent / "grading_config.json"
_VERDICTS = ("strong", "weak", "missing")


def _load_config() -> dict[str, Any]:
    try:
        return json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {
            "model": {"name": "openai/gpt-4o-mini", "version": "unknown",
                      "temperature": 0, "self_consistency_n": 1, "max_tokens": 1200},
            "rubrics": {}, "prompt_classification_ladder": {},
        }


CONFIG = _load_config()


# ─── Entry point ─────────────────────────────────────────────────────────────


def evaluate(
    session_id: str,
    challenge_id: str,
    test_results: dict[str, bool],
    clone_dir: Path,
    detected_traps: list[dict[str, Any]] | None,
    missed_traps: list[dict[str, Any]] | None,
    signals: Any,
    *,
    ai_assistance: bool = True,
) -> dict[str, Any]:
    """Run the LLM-graded rubrics. Each returns {score, subpoints, note}.

    LLM Communication is vibe-only: on the non-AI track it returns score=None and
    the report marks it N/A.
    """
    challenge_root = Path(settings.challenges_dir) / challenge_id
    rubric = _load_json(challenge_root / ".jivahire" / "rubric.json")
    ctx = _challenge_ctx(challenge_id, rubric)
    code = _read_submission(clone_dir, rubric.get("submission_files", []))

    client = OpenAI(api_key=settings.openai_api_key, base_url=settings.llm_base_url)

    cq = _eval_code_quality(client, ctx, code, test_results,
                            detected_traps or [], missed_traps or [], signals, session_id)
    ar = _eval_architectural_reasoning(client, ctx, code, rubric, signals, session_id)
    if ai_assistance:
        lc = _eval_llm_communication(client, ctx, session_id, signals)
    else:
        lc = {"score": None, "subpoints": [],
              "note": "No AI assistant was used on this track, so there is no prompting to score."}

    return {"code_quality": cq, "architectural_reasoning": ar, "llm_communication": lc}


# ─── Code Quality ────────────────────────────────────────────────────────────


def _eval_code_quality(client, ctx, code, test_results, detected_traps, missed_traps,
                       signals, session_id):
    criteria = _criteria("code_quality")
    if not criteria:
        return _fallback(criteria)
    passed = [t for t, ok in test_results.items() if ok]
    failed = [t for t, ok in test_results.items() if not ok]
    caught = "\n".join(f"  - [{t['id']}] {t['description']}" for t in detected_traps) or "  (none)"
    missed = "\n".join(f"  - [{t['id']}] {t['description']}" for t in missed_traps) or "  (none)"

    prompt = f"""You are grading the CODE QUALITY dimension of a coding-interview submission.

{_challenge_header(ctx)}

TEST RESULTS:
- Build succeeded: {bool(test_results)}
- Passed tags: {passed or 'none'}
- Failed tags: {failed or 'none'}

TRAPS THE CANDIDATE CAUGHT:
{caught}

TRAPS THE CANDIDATE MISSED:
{missed}

CANDIDATE CODE:
```{ctx['code_fence']}
{code}
```

{_signals_block(signals)}

Give ONE overall score 1-10 for code quality. Then, for each criterion, return a
verdict of `strong`, `weak`, or `missing` with 1-2 sentences of evidence (line
numbers, function names, trap ids, failed tags). Be ruthless about
`no_ai_defects`: scan for new races, hallucinated APIs, leaked secrets, or
needless abstractions even if hidden tests passed. Do NOT put a number on
individual criteria.

{_criteria_block(criteria)}

{_schema_block(criteria)}"""
    return _eval_rubric(client, "code_quality", prompt, criteria, session_id)


# ─── Architectural Reasoning (design_why injected) ───────────────────────────

_ARCH_RUBRIC_KEYS = ("description", "tasks", "architectural_criteria",
                     "starter_code_note", "difficulty")


def _eval_architectural_reasoning(client, ctx, code, rubric, signals, session_id):
    criteria = _criteria("architectural_reasoning")
    if not criteria:
        return _fallback(criteria)
    starter = (f"\nSTARTER-CODE NOTE (do NOT credit the candidate for anything here):\n"
               f"{ctx['starter_code_note']}\n" if ctx["starter_code_note"] else "")
    relevant = {k: rubric[k] for k in _ARCH_RUBRIC_KEYS if k in rubric}
    design_why = getattr(signals, "design_why", None)
    why_block = (f"\nCANDIDATE'S STATED DESIGN RATIONALE (extracted from "
                 f"{'chat' if getattr(signals, 'ai_assistance', True) else 'NOTES.md + commits'}):\n"
                 f"{design_why}\n" if design_why else
                 "\nCANDIDATE'S STATED DESIGN RATIONALE: (none extracted — judge `why_before_how` accordingly)\n")

    prompt = f"""You are grading ARCHITECTURAL REASONING — only design decisions the candidate
owned, never starter code. Infer this challenge's core mechanism from the
language and code.

{_challenge_header(ctx)}
{starter}
CHALLENGE RUBRIC (architecture-relevant fields):
{json.dumps(relevant, indent=2)}
{why_block}
CANDIDATE CODE:
```{ctx['code_fence']}
{code}
```

Give ONE overall score 1-10 for architectural reasoning. Then, for each
criterion, return a verdict of `strong`, `weak`, or `missing` with 1-2 sentences
of evidence (line numbers, design choices). Do NOT put a number on individual
criteria.

{_criteria_block(criteria)}

{_schema_block(criteria)}"""
    return _eval_rubric(client, "architectural_reasoning", prompt, criteria, session_id)


# ─── LLM Communication (vibe only) ───────────────────────────────────────────


def _eval_llm_communication(client, ctx, session_id, signals):
    criteria = _criteria("llm_communication")
    if not criteria:
        return _fallback(criteria)
    chat_log = _chat_log_from_db(session_id)
    if not chat_log:
        return {"score": 1.0, "subpoints": [
            {"key": k, "checks": v, "verdict": "missing", "detail": "No chat exchanges recorded."}
            for k, v in criteria.items()
        ], "note": "No chat exchanges recorded for this session."}

    timeline = _unified_timeline_from_db(session_id)
    exchanges = _format_chat_exchanges(chat_log)
    timeline_excerpt = _format_timeline_excerpt(timeline)
    expected = ctx.get("expected_tokens", 30000)
    total_tokens = getattr(signals, "total_chat_tokens", 0)
    ratio = round(total_tokens / max(expected, 1), 2)
    ladder = CONFIG.get("prompt_classification_ladder", {})
    ladder_block = "\n".join(f"  {lvl}: {desc}" for lvl, desc in ladder.items())

    prompt = f"""You are grading LLM COMMUNICATION — how effectively the candidate prompted the
AI (prompt-side skill only; what they DID with the output is scored elsewhere).

{_challenge_header(ctx)}

CANDIDATE'S CHAT EXCHANGES (numbered):
{exchanges}

UNIFIED TIMELINE EXCERPT (chat + edits + tests, with sequence numbers):
{timeline_excerpt}

TOKEN USAGE: {total_tokens:,} chat tokens vs {expected:,} expected (ratio={ratio}).
Use this for `token_discipline` only; don't penalise lean spend that worked.

PROMPT CLASSIFICATION LADDER (context; do not output classifications):
{ladder_block}

Give ONE overall score 1-10 for communication. Then, for each criterion, return
a verdict of `strong`, `weak`, or `missing` with 1-2 sentences citing prompt
numbers / sequence numbers. Do NOT put a number on individual criteria.

{_criteria_block(criteria)}

{_schema_block(criteria)}"""
    return _eval_rubric(client, "llm_communication", prompt, criteria, session_id)


# ─── Single structured call (n = 1, temp 0) ──────────────────────────────────


def _eval_rubric(client, rubric_key, prompt, criteria, session_id) -> dict[str, Any]:
    parsed = _single_call(client, prompt, f"llm_eval.{rubric_key}", session_id)
    if not parsed:
        return _fallback(criteria)
    score = _coerce_score(parsed.get("score"))
    crit = parsed.get("criteria") if isinstance(parsed.get("criteria"), dict) else {}
    subs = []
    for key, desc in criteria.items():
        entry = crit.get(key) if isinstance(crit.get(key), dict) else {}
        subs.append({
            "key": key,
            "checks": desc,
            "verdict": _coerce_verdict(entry.get("verdict")),
            "detail": (entry.get("detail") or entry.get("reasoning") or "").strip(),
        })
    return {"score": score if score is not None else _FALLBACK_SCORE,
            "subpoints": subs, "note": None}


def _single_call(client: OpenAI, prompt: str, stage: str, session_id: str):
    model_cfg = CONFIG["model"]
    model_name = model_cfg.get("name") or settings.grader_model
    max_tokens = int(model_cfg.get("max_tokens", 1200))
    temp = float(model_cfg.get("temperature", 0))
    for _ in range(2):
        try:
            resp = client.chat.completions.create(
                model=model_name,
                messages=[{"role": "user", "content": prompt}],
                temperature=temp, max_tokens=max_tokens,
                response_format={"type": "json_object"},
            )
            text = (resp.choices[0].message.content or "").strip()
            text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
            data = json.loads(text)
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            _record_grading_error(session_id, f"{stage}.parse", "JSONDecodeError")
            continue
        except Exception as e:
            _record_grading_error(session_id, stage, type(e).__name__)
            return None
    return None


def _fallback(criteria: dict[str, str]) -> dict[str, Any]:
    return {
        "score": _FALLBACK_SCORE,
        "subpoints": [
            {"key": k, "checks": v, "verdict": "missing", "detail": "LLM grading unavailable."}
            for k, v in (criteria or {}).items()
        ],
        "note": "LLM grading failed — fallback score applied.",
    }


# ─── Config / prompt helpers ─────────────────────────────────────────────────


def _criteria(rubric_key: str) -> dict[str, str]:
    return CONFIG.get("rubrics", {}).get(rubric_key, {}).get("criteria", {}) or {}


def _criteria_block(criteria: dict[str, str]) -> str:
    lines = "\n".join(f"  - {k}: {v}" for k, v in criteria.items())
    return f"CRITERIA:\n{lines}"


def _schema_block(criteria: dict[str, str]) -> str:
    inner = ",\n    ".join(
        f'"{k}": {{"verdict": "strong|weak|missing", "detail": "<1-2 sentences>"}}'
        for k in criteria
    )
    return ('Respond with JSON only, in this exact shape:\n'
            '{\n  "score": <overall 1-10 integer or decimal>,\n  "criteria": {\n    '
            + inner + "\n  }\n}")


def _coerce_score(val: Any) -> float | None:
    if isinstance(val, bool):
        return None
    try:
        return max(1.0, min(10.0, float(val)))
    except (TypeError, ValueError):
        return None


def _coerce_verdict(val: Any) -> str:
    if isinstance(val, str) and val.strip().lower() in _VERDICTS:
        return val.strip().lower()
    return "missing"


def _challenge_ctx(challenge_id: str, rubric: dict[str, Any]) -> dict[str, Any]:
    language = rubric.get("language", "")
    return {
        "id": challenge_id,
        "title": rubric.get("title") or challenge_id,
        "description": rubric.get("description", ""),
        "language": language,
        "code_fence": rubric.get("code_fence") or language or "",
        "starter_code_note": rubric.get("starter_code_note", ""),
        "expected_tokens": rubric.get("expected_tokens", 30000),
    }


def _challenge_header(ctx: dict[str, Any]) -> str:
    lines = [f"CHALLENGE: {ctx['title']}"]
    if ctx["description"]:
        lines.append(ctx["description"])
    if ctx["language"]:
        lines.append(f"LANGUAGE: {ctx['language']}")
    return "\n".join(lines)


def _signals_block(signals: Any) -> str:
    if signals is None:
        return ""
    return (
        "BEHAVIORAL SIGNALS (context only):\n"
        f"- Typed {getattr(signals, 'typed_chars', 0):,} / Pasted {getattr(signals, 'pasted_chars', 0):,} chars"
        f" · Paste% {getattr(signals, 'paste_pct', 0)}\n"
        f"- AI-applied {getattr(signals, 'ai_applied_chars', 0):,} chars ({getattr(signals, 'ai_applied_pct', 0)}%)\n"
        f"- Suspicious pastes {getattr(signals, 'suspicious_pastes', 0)} · Window switches {getattr(signals, 'window_switches', 0)}"
    )


# ─── Readers ─────────────────────────────────────────────────────────────────


def _read_file(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return ""


def _read_submission(clone_dir: Path, submission_files: list[str]) -> str:
    if not submission_files:
        return ""
    parts = []
    for rel in submission_files:
        content = _read_file(clone_dir / rel)
        if content:
            parts.append(f"// ===== {rel} =====\n{content}")
    return "\n\n".join(parts)


def _chat_log_from_db(session_id: str) -> list[dict[str, Any]]:
    rows = query(
        "SELECT id, ts, prompt_text, prompt_tokens, completion_tokens, model "
        "FROM chat_exchanges WHERE session_id=? AND prompt_text IS NOT NULL ORDER BY ts ASC",
        (session_id,),
    )
    return [
        {"sequence": i + 1, "timestamp": r["ts"], "prompt_text": r["prompt_text"] or "",
         "response_text": "", "model_used": r["model"] or ""}
        for i, r in enumerate(rows)
    ]


def _unified_timeline_from_db(session_id: str) -> list[dict[str, Any]]:
    chats = query(
        "SELECT ts, prompt_text FROM chat_exchanges WHERE session_id=? AND prompt_text IS NOT NULL",
        (session_id,),
    )
    events = query("SELECT ts, event_type, payload FROM telemetry WHERE session_id=?", (session_id,))
    merged: list[dict[str, Any]] = []
    for c in chats:
        merged.append({"ts": c["ts"], "event_type": "chat", "prompt_text": c["prompt_text"] or ""})
    for e in events:
        try:
            payload = json.loads(e["payload"]) if isinstance(e["payload"], str) else (e["payload"] or {})
        except Exception:
            payload = {}
        merged.append({"ts": e["ts"], "event_type": e["event_type"], "payload": payload})
    merged.sort(key=lambda x: x["ts"])
    for i, entry in enumerate(merged):
        entry["sequence"] = i + 1
    return merged


def _format_chat_exchanges(chat_log: list[dict[str, Any]], max_chars: int = 400) -> str:
    if not chat_log:
        return "(none)"
    return "\n\n".join(
        f"[{i+1}] seq={e.get('sequence')} Candidate: {e.get('prompt_text', '')[:max_chars]}"
        for i, e in enumerate(chat_log[:20])
    )


def _format_timeline_excerpt(timeline: list[dict[str, Any]], limit: int = 40) -> str:
    if not timeline:
        return "(empty)"
    out = []
    for e in timeline[:limit]:
        seq = e.get("sequence")
        typ = e.get("event_type")
        if typ == "chat":
            out.append(f"  seq={seq} chat: {(e.get('prompt_text', '') or '')[:60]}")
        else:
            payload = e.get("payload") or {}
            extras = []
            if "file" in payload:
                extras.append(str(payload["file"]))
            if "block_id" in payload:
                extras.append(f"block={payload['block_id']}")
            out.append(f"  seq={seq} {typ}: {' '.join(extras)}")
    return "\n".join(out)


def _load_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


# ─── Plain-text commentary call (used by developer_signals + report) ─────────


def _commentary_call(client: OpenAI, prompt: str, fallback: str,
                     session_id: str | None = None) -> str:
    try:
        resp = client.chat.completions.create(
            model=CONFIG["model"].get("name") or settings.grader_model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0, max_tokens=200,
        )
        return resp.choices[0].message.content or fallback
    except Exception:
        return fallback


# ─── Error logging ───────────────────────────────────────────────────────────


def _record_grading_error(session_id: str, stage: str, error_class: str) -> None:
    try:
        from vibe.db import execute
        execute(
            "INSERT INTO grading_errors (session_id, ts, user_message, stage, error_class, traceback) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (session_id, int(time.time() * 1000), f"LLM grader stage {stage} failed",
             stage, error_class, traceback.format_exc()),
        )
    except Exception:
        pass
