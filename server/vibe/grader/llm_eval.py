"""
LLM-graded dimensions (Code Quality 15%, LLM Communication 17%, Architectural
Reasoning 10%).

Per GRADING_RUBRICS.md "Reliability Requirements" each evaluator:
  1. Returns structured JSON sub-scores per criterion (never a freeform 1-10).
  2. Runs three times at temperature 0; the per-criterion score is the median
     across runs. A single noisy call cannot decide a hire.
  3. Includes 1-2 sentence reasoning per criterion citing specific evidence
     (line numbers, prompt indices, telemetry sequence numbers).
  4. Uses the model + version pinned in `grading_config.json`.

The dimension score is computed deterministically from the per-criterion
medians using the weights in `grading_config.json` (which match the rubric
tables). The recruiter UI gets the full per-criterion breakdown so each score
is defensible.
"""

from __future__ import annotations

import collections
import json
import re
import statistics
import time
import traceback
from pathlib import Path
from typing import Any

from openai import OpenAI

from vibe.config import settings
from vibe.db import execute, query

_FALLBACK_SCORE = 5.0
_CONFIG_PATH = Path(__file__).parent.parent / "grading_config.json"


def _load_config() -> dict[str, Any]:
    try:
        return json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        # Hard fallback so the grader still runs if the config file is missing.
        return {
            "model": {"name": "openai/gpt-4o-mini", "version": "unknown",
                      "temperature": 0, "self_consistency_n": 3, "max_tokens": 1200},
            "code_quality": {"weight_in_composite": 0.15, "criteria": {}},
            "llm_communication": {"weight_in_composite": 0.17, "criteria": {}},
            "architectural_reasoning": {"weight_in_composite": 0.10, "criteria": {}},
        }


CONFIG = _load_config()


# ─── Entry point ─────────────────────────────────────────────────────────────


def evaluate(
    session_id: str,
    challenge_id: str,
    test_results: dict[str, bool],
    clone_dir: Path,
    detected_traps: list[dict[str, Any]] | None = None,
    missed_traps: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Run all three LLM-graded dimensions and return a structured result.

    Returns:
        {
          "code_quality":            {"score": float, "breakdown": {...}},
          "architectural_reasoning": {"score": float, "breakdown": {...}},
          "llm_communication":       {"score": float, "breakdown": {...}},
          "summary": str,
        }
    """
    challenge_root = Path(settings.challenges_dir) / challenge_id
    rubric = _load_json(challenge_root / ".jivahire" / "rubric.json")

    ctx = _challenge_ctx(challenge_id, rubric)
    code = _read_submission(clone_dir, rubric.get("submission_files", []))
    chat_log = _chat_log_from_db(session_id)
    timeline = _unified_timeline_from_db(session_id)
    signals = _gather_signals(session_id, chat_log)

    client = OpenAI(api_key=settings.openai_api_key, base_url=settings.llm_base_url)

    cq = _eval_code_quality(client, ctx, code, test_results, rubric,
                            detected_traps or [], missed_traps or [], signals, session_id)
    ar = _eval_architectural_reasoning(client, ctx, code, rubric, signals, session_id)
    lc = _eval_llm_communication(client, ctx, chat_log, timeline, signals, session_id)

    summary = (
        f"Code quality {cq['score']}/10 · "
        f"LLM communication {lc['score']}/10 · "
        f"Architectural reasoning {ar['score']}/10"
    )
    return {
        "code_quality": cq,
        "architectural_reasoning": ar,
        "llm_communication": lc,
        "summary": summary,
    }


# ─── Code Quality (5 criteria) ───────────────────────────────────────────────


def _eval_code_quality(client, ctx, code, test_results, rubric,
                       detected_traps, missed_traps, signals, session_id):
    cfg = CONFIG["code_quality"]["criteria"]
    if not cfg:
        return {"score": _FALLBACK_SCORE, "breakdown": {"reason": "no config"}}

    passed = [t for t, ok in test_results.items() if ok]
    failed = [t for t, ok in test_results.items() if not ok]
    caught = "\n".join(f"  - [{t['id']}] {t['description']}" for t in detected_traps) or "  (none)"
    missed = "\n".join(f"  - [{t['id']}] {t['description']}" for t in missed_traps) or "  (none)"

    criteria_block = _format_criteria(cfg)
    schema_block = _criteria_schema_block(cfg)

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

GRADING TASK — score each of the following CRITERIA on a 1-10 scale.
Provide 1-2 sentences of reasoning per criterion citing specific evidence
(line numbers, function names, trap ids, failed tags). Be ruthless about
"no_ai_defects": scan for new races, hallucinated APIs, log-secret leaks,
exception types the caller doesn't handle, or AI-added abstractions the
problem doesn't need — even if hidden tests passed.

CRITERIA:
{criteria_block}

Respond with JSON only, in this exact shape:
{schema_block}"""

    return _eval_structured(client, prompt, cfg, "llm_eval.code_quality", session_id)


# ─── LLM Communication (6 criteria + 1-5 ladder) ─────────────────────────────


def _eval_llm_communication(client, ctx, chat_log, timeline, signals, session_id):
    cfg = CONFIG["llm_communication"]["criteria"]
    ladder = CONFIG["llm_communication"].get("prompt_classification_ladder", {})
    if not cfg:
        return {"score": _FALLBACK_SCORE, "breakdown": {"reason": "no config"}}

    if not chat_log:
        return {
            "score": 1.0,
            "breakdown": {
                "reason": "no chat exchanges recorded for this session",
                "criteria": {},
            },
        }

    exchanges = _format_chat_exchanges(chat_log, max_chars=400)
    timeline_excerpt = _format_timeline_excerpt(timeline, limit=40)

    expected = ctx.get("expected_tokens", 30000)
    total_tokens = signals.get("total_chat_tokens", 0) if signals else 0
    ratio = round(total_tokens / max(expected, 1), 2)

    criteria_block = _format_criteria(cfg)
    schema_block = _criteria_schema_block(cfg)
    ladder_block = "\n".join(f"  {level}: {desc}" for level, desc in ladder.items())

    prompt = f"""You are grading the LLM COMMUNICATION dimension — how effectively the candidate
prompted the AI assistant. Evaluate prompt-side skill only; what the candidate
DID with the AI output is scored separately under Verification Discipline and
AI Judgment.

{_challenge_header(ctx)}

CANDIDATE'S CHAT EXCHANGES (numbered; AI responses truncated to 400 chars):
{exchanges}

UNIFIED TIMELINE EXCERPT (chat + edits + tests, with sequence numbers):
{timeline_excerpt}

TOKEN USAGE: {total_tokens:,} total chat tokens vs {expected:,} expected for
this challenge (ratio={ratio}). Use this for the "token_discipline" criterion
only; do not penalise lean spend that produced working code.

GRADING TASK — score each CRITERION 1-10 with 1-2 sentences of reasoning
citing specific evidence (e.g. "prompt #3 dumps the whole file with no
question", "follow-up #5 cites the failing assertion from test_run at seq=42").

PROMPT CLASSIFICATION LADDER (informs scoring; do not output classifications
here — they're saved separately):
{ladder_block}

CRITERIA:
{criteria_block}

Respond with JSON only, in this exact shape:
{schema_block}"""

    result = _eval_structured(client, prompt, cfg, "llm_eval.llm_communication", session_id)

    # Side effect: classify each prompt (vague/specific/professional + 1-10
    # score + 1-line reasoning) and persist to chat_exchanges so the recruiter
    # "Candidate Prompts" card can render badges and reasoning. Best-effort —
    # failure here does not affect the dimension score.
    try:
        _classify_prompts_and_persist(client, chat_log, ladder, session_id)
    except Exception:
        pass
    return result


# ─── Architectural Reasoning (7 criteria) ────────────────────────────────────

_ARCH_RUBRIC_KEYS = ("description", "tasks", "architectural_criteria",
                     "starter_code_note", "difficulty")


def _eval_architectural_reasoning(client, ctx, code, rubric, signals, session_id):
    cfg = CONFIG["architectural_reasoning"]["criteria"]
    if not cfg:
        return {"score": _FALLBACK_SCORE, "breakdown": {"reason": "no config"}}

    starter_block = (
        f"\nSTARTER-CODE NOTE (do NOT credit the candidate for anything in this note):\n"
        f"{ctx['starter_code_note']}\n"
        if ctx["starter_code_note"] else ""
    )
    relevant_rubric = {k: rubric[k] for k in _ARCH_RUBRIC_KEYS if k in rubric}
    criteria_block = _format_criteria(cfg)
    schema_block = _criteria_schema_block(cfg)

    prompt = f"""You are grading the ARCHITECTURAL REASONING dimension — the quality of
design decisions the candidate was responsible for. Decisions already present
in the starter code do NOT count.

{_challenge_header(ctx)}
{starter_block}
CHALLENGE RUBRIC (architecture-relevant fields):
{json.dumps(relevant_rubric, indent=2)}

CANDIDATE CODE:
```{ctx['code_fence']}
{code}
```

GRADING TASK — score each CRITERION 1-10 with 1-2 sentences of reasoning
citing specific evidence (line numbers, design choices). For "why_before_how"
the evidence will live in the chat log; for the others it lives in the code.

CRITERIA:
{criteria_block}

Respond with JSON only, in this exact shape:
{schema_block}"""

    return _eval_structured(client, prompt, cfg, "llm_eval.architectural_reasoning", session_id)


# ─── Structured-output LLM call (median of N at temp 0) ─────────────────────


def _eval_structured(client, prompt: str, criteria_cfg: dict[str, dict[str, Any]],
                     stage: str, session_id: str) -> dict[str, Any]:
    """Run the prompt N times at temp 0 and merge per-criterion medians."""
    model_cfg = CONFIG["model"]
    n = int(model_cfg.get("self_consistency_n", 3))
    runs: list[dict[str, dict[str, Any]]] = []
    for _ in range(n):
        parsed = _single_structured_call(client, prompt, stage, session_id)
        if parsed:
            runs.append(parsed)

    weights = {k: v["weight"] for k, v in criteria_cfg.items()}
    if not runs:
        # Total failure — emit a fallback breakdown so the row still inserts.
        merged = {
            k: {"score": _FALLBACK_SCORE, "reasoning": "LLM call failed",
                "evidence": [], "weight": weights[k]}
            for k in criteria_cfg
        }
        return {
            "score": _FALLBACK_SCORE,
            "breakdown": {"criteria": merged, "weights": weights, "runs": 0},
        }

    merged: dict[str, dict[str, Any]] = {}
    for key in criteria_cfg:
        scores: list[float] = []
        reasonings: list[str] = []
        evidence: set[str] = set()
        for r in runs:
            entry = r.get(key)
            if not isinstance(entry, dict):
                continue
            sc = _coerce_score(entry.get("score"))
            if sc is None:
                continue
            scores.append(sc)
            reasoning = entry.get("reasoning") or entry.get("analysis") or ""
            if reasoning:
                reasonings.append(str(reasoning))
            for e in entry.get("evidence") or []:
                if isinstance(e, str):
                    evidence.add(e)
        if scores:
            merged[key] = {
                "score": round(float(statistics.median(scores)), 2),
                "reasoning": " | ".join(reasonings),
                "evidence": sorted(evidence),
                "weight": weights[key],
                "runs": len(scores),
            }
        else:
            merged[key] = {
                "score": _FALLBACK_SCORE,
                "reasoning": "criterion missing from all LLM runs",
                "evidence": [],
                "weight": weights[key],
                "runs": 0,
            }

    dim_score = sum(m["score"] * weights[k] for k, m in merged.items())
    return {
        "score": round(float(dim_score), 2),
        "breakdown": {"criteria": merged, "weights": weights, "runs": len(runs)},
    }


def _single_structured_call(client: OpenAI, prompt: str, stage: str,
                            session_id: str) -> dict[str, dict[str, Any]] | None:
    model_cfg = CONFIG["model"]
    model_name = model_cfg.get("name") or settings.grader_model
    max_tokens = int(model_cfg.get("max_tokens", 1200))
    temp = float(model_cfg.get("temperature", 0))
    for attempt in range(2):
        try:
            resp = client.chat.completions.create(
                model=model_name,
                messages=[{"role": "user", "content": prompt}],
                temperature=temp,
                max_tokens=max_tokens,
                response_format={"type": "json_object"},
            )
            text = (resp.choices[0].message.content or "").strip()
            text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
            data = json.loads(text)
            # Accept both {"criteria": {...}} and the top-level form.
            if "criteria" in data and isinstance(data["criteria"], dict):
                data = data["criteria"]
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            _record_grading_error(session_id, f"{stage}.parse", "JSONDecodeError")
            continue
        except Exception as e:
            _record_grading_error(session_id, stage, type(e).__name__)
            return None
    return None


# ─── Prompt-classification side effect ───────────────────────────────────────


_CLASSIFICATION_VALUES = ("vague", "specific", "professional")

# Map the 1-5 ladder level → recruiter-facing classification bucket. The UI
# (server/static/app.js: promptClassBadge) recognises three buckets.
_LEVEL_TO_CLASSIFICATION = {5: "professional", 4: "professional",
                            3: "specific",     2: "vague", 1: "vague"}


def _classify_prompts_and_persist(client: OpenAI, chat_log: list[dict[str, Any]],
                                  ladder: dict[str, str], session_id: str) -> None:
    """Score and classify each candidate prompt; persist to chat_exchanges.

    Writes three columns the recruiter UI reads:
      - prompt_classification: 'vague' | 'specific' | 'professional'
      - prompt_score:          integer 1-10 (UI tooltip: 0=vague, 10=professional)
      - prompt_reasoning:      1-sentence justification

    Also writes the 1-5 ladder level (prompt_level) for back-compat. Single LLM
    call (not self-consistent — this is for display, not scoring).
    """
    if not chat_log:
        return
    prompts = [(i, e.get("prompt_text", "")) for i, e in enumerate(chat_log)
               if e.get("prompt_text")]
    if not prompts:
        return

    ladder_block = "\n".join(f"  {level} - {desc}" for level, desc in ladder.items()) \
        if ladder else "  (no ladder configured)"
    numbered = "\n".join(f"[{i+1}] {p[:400]}" for i, p in prompts)
    prompt = f"""Rate each candidate prompt below. Return JSON only.

CLASSIFICATION BUCKETS (recruiter-facing badge):
  professional — cites exact errors, types, line numbers, constraints, or runtime behaviour
  specific     — names the problem/symptom but lacks technical precision
  vague        — generic requests, "fix this", no context

1-5 LADDER (for context; informs the 1-10 score):
{ladder_block}

PROMPTS:
{numbered}

For each prompt return:
  - "index":          the prompt number above
  - "classification": one of "vague" | "specific" | "professional"
  - "level":          1-5 on the ladder
  - "score":          integer 1-10 (1 = counterproductive, 10 = model-native)
  - "reasoning":      one short sentence citing what makes the prompt vague/specific/professional

Respond with: {{"classifications": [
  {{"index": 1, "classification": "...", "level": 1-5, "score": 1-10, "reasoning": "..."}},
  ...
]}}"""
    try:
        resp = client.chat.completions.create(
            model=CONFIG["model"].get("name") or settings.grader_model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            max_tokens=900,
            response_format={"type": "json_object"},
        )
        data = json.loads((resp.choices[0].message.content or "").strip())
    except Exception:
        return  # display-only metadata; never block scoring

    rows = query(
        "SELECT id, ts FROM chat_exchanges WHERE session_id=? ORDER BY ts ASC",
        (session_id,),
    )
    for c in data.get("classifications") or []:
        if not isinstance(c, dict):
            continue
        idx = c.get("index")
        if not isinstance(idx, int) or not (0 < idx <= len(rows)):
            continue

        level = c.get("level") if isinstance(c.get("level"), int) else None
        if level is not None and not (1 <= level <= 5):
            level = None

        score = c.get("score")
        if isinstance(score, (int, float)):
            score = max(1, min(10, int(round(score))))
        else:
            score = None

        classification = c.get("classification")
        if classification not in _CLASSIFICATION_VALUES:
            classification = _LEVEL_TO_CLASSIFICATION.get(level) if level else None

        reasoning = c.get("reasoning")
        if isinstance(reasoning, str):
            reasoning = reasoning.strip() or None
        else:
            reasoning = None

        execute(
            "UPDATE chat_exchanges SET prompt_classification=?, prompt_score=?, "
            "prompt_reasoning=?, prompt_level=? WHERE id=?",
            (classification, score, reasoning, level, rows[idx - 1]["id"]),
        )


# ─── Prompt-shaping helpers ──────────────────────────────────────────────────


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


def _format_criteria(cfg: dict[str, dict[str, Any]]) -> str:
    return "\n".join(
        f"  - {key} (weight {meta['weight']:.0%}): {meta.get('description', '')}"
        for key, meta in cfg.items()
    )


def _criteria_schema_block(cfg: dict[str, dict[str, Any]]) -> str:
    inner = ",\n  ".join(
        f'"{key}": {{"score": <1-10>, "reasoning": "<1-2 sentences with evidence>", '
        f'"evidence": ["<token>", "..."]}}'
        for key in cfg
    )
    return "{\n  " + inner + "\n}"


def _format_chat_exchanges(chat_log: list[dict[str, Any]], max_chars: int = 400) -> str:
    if not chat_log:
        return "(none)"
    return "\n\n".join(
        f"[{i+1}] seq={e.get('sequence')} Candidate: {e.get('prompt_text', '')[:max_chars]}\n"
        f"    AI: {(e.get('response_text', '') or '')[:max_chars]}"
        for i, e in enumerate(chat_log[:20])  # cap at 20 per rubric
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
            if "post_apply_of" in payload:
                extras.append(f"post_apply_of={payload['post_apply_of']}")
            out.append(f"  seq={seq} {typ}: {' '.join(extras)}")
    return "\n".join(out)


# ─── Telemetry signals (preserved from prior version) ────────────────────────


def _gather_signals(session_id: str, chat_log: list[dict[str, Any]]) -> dict[str, Any]:
    tel_rows = query(
        "SELECT event_type, payload FROM telemetry WHERE session_id=?",
        (session_id,),
    )
    typed_chars = pasted_chars = window_switches = suspicious_pastes = 0
    for row in tel_rows:
        evt = row["event_type"]
        try:
            pl = json.loads(row["payload"]) if isinstance(row["payload"], str) else (row["payload"] or {})
        except Exception:
            pl = {}
        if evt == "edit_typed":
            typed_chars += pl.get("chars", 0)
        elif evt == "edit_pasted":
            pasted_chars += pl.get("chars", 0)
            if pl.get("suspicious_paste"):
                suspicious_pastes += 1
        elif evt == "app_focused":
            window_switches += 1

    total_chars = max(typed_chars + pasted_chars, 1)
    paste_pct = round(pasted_chars / total_chars * 100, 1)

    ai_applied_chars = 0
    try:
        sess = query("SELECT ai_applied_chars FROM sessions WHERE id=?", (session_id,))
        if sess:
            ai_applied_chars = sess[0].get("ai_applied_chars") or 0
    except Exception:
        pass
    ai_applied_pct = round(
        ai_applied_chars / max(typed_chars + pasted_chars + ai_applied_chars, 1) * 100, 1
    )

    cx_rows = query(
        "SELECT prompt_tokens, completion_tokens, cached_input_tokens, reasoning_tokens "
        "FROM chat_exchanges WHERE session_id=? ORDER BY ts",
        (session_id,),
    )
    total_prompt_tokens = sum(r["prompt_tokens"] or 0 for r in cx_rows)
    total_completion = sum(r["completion_tokens"] or 0 for r in cx_rows)
    total_chat_tokens = total_prompt_tokens + total_completion
    num_exchanges = len(cx_rows)

    correction_loops = sum(1 for e in chat_log if e.get("correction_loop"))
    return {
        "typed_chars": typed_chars,
        "pasted_chars": pasted_chars,
        "ai_applied_chars": ai_applied_chars,
        "paste_pct": paste_pct,
        "ai_applied_pct": ai_applied_pct,
        "window_switches": window_switches,
        "suspicious_pastes": suspicious_pastes,
        "correction_loops": correction_loops,
        "total_chat_tokens": total_chat_tokens,
        "total_prompt_tokens": total_prompt_tokens,
        "total_completion_tokens": total_completion,
        "num_chat_exchanges": num_exchanges,
    }


def _signals_block(signals: dict[str, Any]) -> str:
    if not signals:
        return ""
    return (
        "BEHAVIORAL SIGNALS:\n"
        f"- Typed: {signals['typed_chars']:,} chars · Pasted: {signals['pasted_chars']:,} chars"
        f" · Paste%: {signals['paste_pct']:.0f}%\n"
        f"- AI-applied: {signals['ai_applied_chars']:,} chars ({signals['ai_applied_pct']:.0f}%)\n"
        f"- Suspicious pastes: {signals['suspicious_pastes']} · Window switches: {signals['window_switches']}\n"
        f"- Chat exchanges: {signals.get('num_chat_exchanges', 0)} · "
        f"Total chat tokens: {signals.get('total_chat_tokens', 0):,}"
    )


# ─── Score coercion ──────────────────────────────────────────────────────────


def _coerce_score(val: Any) -> float | None:
    if isinstance(val, bool):
        return None
    try:
        f = float(val)
    except (TypeError, ValueError):
        return None
    return max(1.0, min(10.0, f))


# ─── File / log readers ──────────────────────────────────────────────────────


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
    """Chat-only entries from `chat_exchanges` (sole source of truth since
    the on-branch `.jivahire_chat_log.json` was retired). Used by the LLM
    Communication evaluator, which scores the prompts the candidate sent.
    The DB has no response_text column; entries leave it blank.
    """
    rows = query(
        "SELECT id, ts, prompt_text, prompt_tokens, completion_tokens, model "
        "FROM chat_exchanges WHERE session_id=? AND prompt_text IS NOT NULL "
        "ORDER BY ts ASC",
        (session_id,),
    )
    return [
        {
            "sequence": i + 1,
            "timestamp": r["ts"],
            "event_type": "chat",
            "prompt_text": r["prompt_text"] or "",
            "response_text": "",
            "model_used": r["model"] or "",
            "prompt_tokens": r["prompt_tokens"] or 0,
            "response_tokens": r["completion_tokens"] or 0,
        }
        for i, r in enumerate(rows)
    ]


def _unified_timeline_from_db(session_id: str) -> list[dict[str, Any]]:
    """Merge `chat_exchanges` + `telemetry` rows into one timeline, sorted by
    ts, with a sequence number assigned in chronological order. Used by the
    LLM Communication evaluator so it can cite "test ran 45s after AI apply"
    or "follow-up #7 referenced response #6" as evidence.

    The on-branch JSON file used to carry the same shape with a sequence
    counter incremented at write time; we now compute the sequence at grade
    time. The two are equivalent so long as ts ordering matches the live
    counter — which it does, because the extension emits events in real time.
    """
    chats = query(
        "SELECT ts, prompt_text FROM chat_exchanges "
        "WHERE session_id=? AND prompt_text IS NOT NULL",
        (session_id,),
    )
    events = query(
        "SELECT ts, event_type, payload FROM telemetry WHERE session_id=?",
        (session_id,),
    )
    merged: list[dict[str, Any]] = []
    for c in chats:
        merged.append({
            "ts": c["ts"],
            "event_type": "chat",
            "prompt_text": c["prompt_text"] or "",
        })
    for e in events:
        try:
            payload = json.loads(e["payload"]) if isinstance(e["payload"], str) else (e["payload"] or {})
        except Exception:
            payload = {}
        merged.append({
            "ts": e["ts"],
            "event_type": e["event_type"],
            "payload": payload,
        })
    merged.sort(key=lambda x: x["ts"])
    for i, entry in enumerate(merged):
        entry["sequence"] = i + 1
    return merged


def _load_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


# ─── Plain-text commentary call (used by developer_signals) ─────────────────


def _commentary_call(client: OpenAI, prompt: str, fallback: str,
                      session_id: str | None = None) -> str:
    """Non-structured single-call helper for narrative summaries (e.g.
    developer-confidence verdict reasoning). Always returns a string —
    fallback on any failure so callers don't have to handle exceptions."""
    try:
        resp = client.chat.completions.create(
            model=CONFIG["model"].get("name") or settings.grader_model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            max_tokens=200,
        )
        return resp.choices[0].message.content or fallback
    except Exception:
        return fallback


# ─── Error logging ──────────────────────────────────────────────────────────


def _record_grading_error(session_id: str, stage: str, error_class: str) -> None:
    try:
        execute(
            "INSERT INTO grading_errors (session_id, ts, user_message, stage, error_class, traceback) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                session_id, int(time.time() * 1000),
                f"LLM grader stage {stage} failed",
                stage, error_class, traceback.format_exc(),
            ),
        )
    except Exception:
        pass
