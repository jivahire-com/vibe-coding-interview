import collections
import json
import re
import statistics
import time
import traceback
from pathlib import Path

from openai import OpenAI

from vibe.config import settings
from vibe.db import execute, query

_FALLBACK_SCORE = 5

# Temperatures for self-consistency runs (indexed by run index)
_SC_TEMPERATURES = [0.0, 0.4, 0.7]

_DEFAULT_CODE_QUALITY_CRITERIA = [
    "Correctness (does it pass the tests and fix the planted traps?)",
    "Idiomatic use of the language",
    "Clarity and naming",
    "Robust handling of error and edge cases",
]

_DEFAULT_ARCHITECTURAL_CRITERIA = [
    "Algorithm choice and time/space complexity (only credit if the candidate decided it)",
    "Data-structure choice and justification (only credit if the candidate decided it)",
    "Concurrency / synchronisation design, where applicable",
    "Edge-case awareness and boundary handling",
]

_CODE_QUALITY_ANCHORS = """SCORE ANCHORS — calibrate your score against these examples:
9–10: Compiles cleanly, all or nearly all tests pass, all planted traps fixed, idiomatic style, robust edge-case handling.
   7: Compiles, most tests pass, most traps fixed, generally clean code with minor style/idiom issues.
   5: Compiles, partial test pass, some traps fixed, noticeable style issues, several edge cases unhandled.
   3: Builds with warnings or partial failures, few traps fixed, weak style, multiple correctness gaps.
   2: Major compilation errors, most tests fail, traps not addressed, unsafe patterns or clear logic errors."""

_AI_ORCHESTRATION_ANCHORS = """SCORE ANCHORS:
9–10: Highly specific prompts with technical context, iterative refinement, clear evidence of understanding and adapting AI output; low paste%, multiple correction loops showing self-correction.
   7: Mostly specific prompts; candidate adapts most AI output and shows some independent reasoning.
   5: Mix of specific and vague prompts; some adaptation of AI suggestions; occasional copy-paste without verification.
   3: Mostly vague prompts; minimal adaptation; high paste% with few correction loops.
   2: Generic prompts only ("fix this"), high paste% with no verification, zero evidence of independent reasoning."""

_ARCHITECTURAL_ANCHORS = """SCORE ANCHORS:
9–10: Non-obvious design decisions with explicit justification — e.g., chose shared_mutex for read-heavy load, carefully scoped critical sections to minimise contention, proved deadlock-free.
   7: Sound design choices with brief justification; addresses key architectural concerns competently.
   5: Adequate choices but no visible justification; competent but unremarkable architecture.
   3: Workable but suboptimal choices (overly coarse locks, missing reasoning about complexity).
   2: Poor choices (coarse locks causing bottlenecks, deadlock risk, missing synchronisation) or no meaningful design decisions made."""


def evaluate(session_id: str, challenge_id: str, test_results: dict, clone_dir: Path,
             detected_traps: list | None = None, missed_traps: list | None = None) -> dict:
    challenge_root = Path(settings.challenges_dir) / challenge_id
    rubric = _load_json(challenge_root / ".jivahire" / "rubric.json")

    ctx = _challenge_ctx(challenge_id, rubric)
    code = _read_submission(clone_dir, rubric.get("submission_files", []))
    chat_log = _read_chat_log(clone_dir)

    signals = _gather_signals(session_id, chat_log)

    client = OpenAI(api_key=settings.openai_api_key, base_url=settings.llm_base_url)

    cq = _eval_code_quality(client, ctx, code, test_results, rubric,
                             detected_traps or [], missed_traps or [], signals, session_id)
    ao = _eval_ai_orchestration(client, ctx, code, chat_log, signals, session_id)
    ar = _eval_architectural_reasoning(client, ctx, code, rubric, session_id)
    pq = _eval_prompt_quality(client, session_id, chat_log, signals)

    summary = (
        f"Code quality ({cq['score']}/10): {cq['reasoning']} | "
        f"AI orchestration ({ao['score']}/10): {ao['reasoning']} | "
        f"Architectural reasoning ({ar['score']}/10): {ar['reasoning']} | "
        f"Prompt quality ({pq['score']}/10): {pq['reasoning']}"
    )

    return {
        "code_quality_score": cq["score"],
        "ai_orchestration_score": ao["score"],
        "architectural_reasoning_score": ar["score"],
        "prompt_quality_score": pq["score"],
        "summary": summary,
    }


def _gather_signals(session_id: str, chat_log: list) -> dict:
    tel_rows = query(
        "SELECT event_type, payload FROM telemetry WHERE session_id=?",
        (session_id,),
    )
    typed_chars = 0
    pasted_chars = 0
    window_switches = 0
    suspicious_pastes = 0
    for row in tel_rows:
        evt = row["event_type"]
        try:
            pl = json.loads(row["payload"]) if isinstance(row["payload"], str) else (row["payload"] or {})
        except Exception:
            pl = {}
        if evt == "edit_batch":
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
            ai_applied_chars = sess[0]["ai_applied_chars"] or 0
    except Exception:
        pass
    ai_applied_pct = round(ai_applied_chars / max(typed_chars + pasted_chars + ai_applied_chars, 1) * 100, 1)

    cx_rows = query(
        "SELECT prompt_classification, prompt_tokens, completion_tokens, "
        "cached_input_tokens, reasoning_tokens "
        "FROM chat_exchanges WHERE session_id=? ORDER BY ts",
        (session_id,),
    )
    cls_counts = collections.Counter(r["prompt_classification"] for r in cx_rows if r["prompt_classification"])
    total_prompt_tokens = sum(r["prompt_tokens"] or 0 for r in cx_rows)
    total_cached = sum(r["cached_input_tokens"] or 0 for r in cx_rows)
    total_reasoning = sum(r["reasoning_tokens"] or 0 for r in cx_rows)
    total_completion = sum(r["completion_tokens"] or 0 for r in cx_rows)
    total_chat_tokens = total_prompt_tokens + total_completion
    num_exchanges = len(cx_rows)

    cache_hit_ratio = round(total_cached / max(total_prompt_tokens, 1) * 100, 1)
    reasoning_token_share = round(total_reasoning / max(total_completion, 1) * 100, 1)

    correction_loops = sum(1 for e in chat_log if e.get("correction_loop"))

    return {
        "typed_chars": typed_chars,
        "pasted_chars": pasted_chars,
        "ai_applied_chars": ai_applied_chars,
        "paste_pct": paste_pct,
        "ai_applied_pct": ai_applied_pct,
        "window_switches": window_switches,
        "suspicious_pastes": suspicious_pastes,
        "classifications": dict(cls_counts),
        "correction_loops": correction_loops,
        "cache_hit_ratio": cache_hit_ratio,
        "reasoning_token_share": reasoning_token_share,
        "total_chat_tokens": total_chat_tokens,
        "total_prompt_tokens": total_prompt_tokens,
        "total_completion_tokens": total_completion,
        "num_chat_exchanges": num_exchanges,
    }


def _signals_block(signals: dict) -> str:
    if not signals:
        return ""
    return (
        "BEHAVIORAL SIGNALS (use these to inform your scoring):\n"
        f"- Typed: {signals['typed_chars']:,} chars | Pasted: {signals['pasted_chars']:,} chars"
        f" | Paste%: {signals['paste_pct']:.0f}%\n"
        f"- AI-applied chars: {signals['ai_applied_chars']:,} | AI-applied%: {signals['ai_applied_pct']:.0f}%\n"
        f"- Window switches: {signals['window_switches']} | Suspicious pastes: {signals['suspicious_pastes']}\n"
        f"- Correction loops: {signals['correction_loops']} | Cache-hit ratio: {signals['cache_hit_ratio']:.0f}%\n"
        f"- Chat exchanges: {signals.get('num_chat_exchanges', 0)} | "
        f"Total chat tokens: {signals.get('total_chat_tokens', 0):,} "
        f"(prompt {signals.get('total_prompt_tokens', 0):,} + completion {signals.get('total_completion_tokens', 0):,})"
    )


_TOKEN_PRODUCTIVITY_GUIDANCE = (
    "TOKEN-USAGE LENS (do NOT score raw token count — judge productivity per token):\n"
    "- Tokens are only meaningful relative to working code and useful direction. Lots of tokens with passing tests, "
    "trap fixes, and visible iteration is fine; few tokens with broken or empty code is bad.\n"
    "- Heavy spend with little working output, repeated regenerations of the same code, or long prompts that "
    "ignore prior context are negatives. Concise, targeted prompts that produce code the candidate then adapts "
    "are positives.\n"
    "- If chat tokens are zero but code is solid, that is independent work — neutral-to-positive, not a penalty."
)


def _challenge_ctx(challenge_id: str, rubric: dict) -> dict:
    language = rubric.get("language", "")
    return {
        "id": challenge_id,
        "title": rubric.get("title") or challenge_id,
        "description": rubric.get("description", ""),
        "language": language,
        "code_fence": rubric.get("code_fence") or language or "",
        "starter_code_note": rubric.get("starter_code_note", ""),
    }


def _challenge_header(ctx: dict) -> str:
    lines = [f"CHALLENGE: {ctx['title']}"]
    if ctx["description"]:
        lines.append(ctx["description"])
    if ctx["language"]:
        lines.append(f"LANGUAGE: {ctx['language']}")
    return "\n".join(lines)


def _bullet_list(items: list[str]) -> str:
    return "\n".join(f"- {x}" for x in items)


def _eval_code_quality(client, ctx: dict, code: str, test_results: dict, rubric: dict,
                        detected_traps: list, missed_traps: list, signals: dict,
                        session_id: str) -> dict:
    passed = [tag for tag, ok in test_results.items() if ok]
    failed = [tag for tag, ok in test_results.items() if not ok]
    build_failed = not test_results
    criteria = rubric.get("code_quality_criteria") or _DEFAULT_CODE_QUALITY_CRITERIA

    caught_block = ""
    if detected_traps:
        lines = "\n".join(f"  - [{t['id']}] {t['description']}" for t in detected_traps)
        caught_block = f"\nTRAPS THE CANDIDATE CAUGHT:\n{lines}"
    missed_block = ""
    if missed_traps:
        lines = "\n".join(f"  - [{t['id']}] {t['description']}" for t in missed_traps)
        missed_block = f"\nTRAPS THE CANDIDATE MISSED:\n{lines}"

    sigs = _signals_block(signals)

    prompt = f"""You are grading a coding interview submission.

{_challenge_header(ctx)}

RUBRIC TASKS:
{json.dumps(rubric.get('tasks', []), indent=2)}
{caught_block}{missed_block}

TEST RESULTS:
- Build/compile succeeded: {not build_failed}
- Passed tags: {passed or 'none'}
- Failed tags: {failed or 'none'}

CANDIDATE CODE:
```{ctx['code_fence']}
{code}
```

{_CODE_QUALITY_ANCHORS}

{sigs}

{_TOKEN_PRODUCTIVITY_GUIDANCE}

CRITERIA:
{_bullet_list(criteria)}

ADJUSTMENTS:
- If paste% > 70%, cap the score at 7 unless the code shows evidence of post-paste edits, refactoring, or adaptation (do not reward verbatim AI output).
- If TRAPS THE CANDIDATE MISSED is non-empty, deduct at least 1 point per critical miss visible in the code.
- Reference token productivity in your analysis: relate chat-token spend to how much working code resulted. Heavy spend with broken or thin code is a negative; lean spend with solid code is a positive. Do not penalise low token use when the code is sound.

Respond with JSON only — emit "analysis" BEFORE "score" to reason first:
{{"analysis": "<3-5 sentences of explicit reasoning>", "score": <int 1-10>, "confidence": <float 0.0-1.0>}}"""

    return _call(client, prompt, "Code quality could not be evaluated.",
                 session_id, "llm_eval.code_quality", use_sc=True)


def _eval_ai_orchestration(client, ctx: dict, code: str, chat_log: list,
                             signals: dict, session_id: str) -> dict:
    if not chat_log:
        return {"score": 1, "reasoning": "No AI chat exchanges recorded — scored at the floor because AI orchestration cannot be evaluated without any AI usage."}

    exchanges_text = "\n\n".join(
        f"[{i+1}] Candidate: {e.get('prompt_text','')}\n    AI: {e.get('response_text','')[:400]}"
        for i, e in enumerate(chat_log)
    )

    sigs = _signals_block(signals)

    prompt = f"""You are evaluating how effectively a candidate used AI assistance during a coding interview.

{_challenge_header(ctx)}

CANDIDATE'S AI CHAT EXCHANGES:
{exchanges_text}

FINAL CODE SUBMITTED:
```{ctx['code_fence']}
{code[:3000]}
```

{_AI_ORCHESTRATION_ANCHORS}

{sigs}

{_TOKEN_PRODUCTIVITY_GUIDANCE}

CRITERIA:
- Prompt quality: specific and targeted vs vague/generic
- Adaptation: understood and adapted AI suggestions rather than blindly copying
- Iteration: followed up on problems; correction loops show self-correction
- Independence: evidence of own reasoning alongside AI use
- Token productivity: did the chat-token spend convert into useful direction and working code? Repeated regenerations or long context-bare prompts that yield little are a negative; tight prompts that produced code the candidate then adapted are a positive.
- If paste% > 70% and correction_loops < 2, deduct for probable blind copy-paste
- If suspicious_pastes > 0, note this as a risk signal

Respond with JSON only — emit "analysis" BEFORE "score":
{{"analysis": "<3-5 sentences of explicit reasoning>", "score": <int 1-10>, "confidence": <float 0.0-1.0>}}"""

    return _call(client, prompt, "AI orchestration could not be evaluated.",
                 session_id, "llm_eval.ai_orchestration", use_sc=True)


_ARCH_RUBRIC_KEYS = ("description", "tasks", "architectural_criteria", "starter_code_note", "difficulty")


def _coerce_score(val) -> int:
    """Coerce a score from JSON (int, float, or numeric string) to a clamped 1-10 int."""
    if isinstance(val, bool):
        raise ValueError(f"score is bool: {val!r}")
    return max(1, min(10, round(float(val))))


def _eval_architectural_reasoning(client, ctx: dict, code: str, rubric: dict,
                                   session_id: str) -> dict:
    criteria = rubric.get("architectural_criteria") or _DEFAULT_ARCHITECTURAL_CRITERIA
    starter_block = (
        f"\nSTARTER-CODE NOTE (read carefully — do NOT credit the candidate for anything in this note):\n"
        f"{ctx['starter_code_note']}\n"
        if ctx["starter_code_note"] else ""
    )

    # Pass only architecture-relevant rubric fields; suppress weights/budgets/expected_tokens noise.
    relevant_rubric = {k: rubric[k] for k in _ARCH_RUBRIC_KEYS if k in rubric}

    prompt = f"""You are evaluating architectural and design decisions in a coding interview.

{_challenge_header(ctx)}
{starter_block}
CHALLENGE RUBRIC (architecture-relevant fields only):
{json.dumps(relevant_rubric, indent=2)}

CANDIDATE CODE:
```{ctx['code_fence']}
{code}
```

{_ARCHITECTURAL_ANCHORS}

Score architectural and design reasoning 1–10. IMPORTANT: score only what the candidate actually decided. If a structure, algorithm, or pattern was already present in the starter code, do not credit them for it — focus on design decisions they were responsible for.

CRITERIA:
{_bullet_list(criteria)}

Respond with JSON only — emit "analysis" BEFORE "score":
{{"analysis": "<3-5 sentences of explicit reasoning>", "score": <int 1-10>, "confidence": <float 0.0-1.0>}}"""

    return _call(client, prompt, "Architectural reasoning could not be evaluated.",
                 session_id, "llm_eval.architectural_reasoning", use_sc=True)


def _eval_prompt_quality(client, session_id: str, chat_log: list, signals: dict) -> dict:
    if not chat_log:
        return {"score": 1, "reasoning": "No prompts to evaluate."}

    prompts = [e.get("prompt_text", "") for e in chat_log if e.get("prompt_text")]
    if not prompts:
        return {"score": 1, "reasoning": "No prompt text found in chat log."}

    classification_prompt = f"""Classify each candidate prompt as one of: vague, specific, professional, and assign a 0–10 quality score (0 = totally vague, 10 = highly professional).

Definitions:
- vague: generic requests without technical context, e.g. "fix this", "please fix this code", "make it work"
- specific: includes the problem or symptom but lacks technical precision, e.g. "function X is returning the wrong value"
- professional: cites exact errors, types, line numbers, constraints, or runtime behaviour, e.g. "function X returns Y for input Z because the loop terminates one iteration early"

Score guidance:
- 0–3: vague
- 4–7: specific (4 = barely specific, 7 = strong specific)
- 8–10: professional (10 = exemplary precision and context)

PROMPTS (numbered):
{chr(10).join(f"[{i+1}] {p}" for i, p in enumerate(prompts))}

Respond with JSON only — a list of objects in the same order:
[{{"index": 1, "classification": "vague|specific|professional", "score": <int 0-10>, "reason": "<one sentence explaining why this prompt earned that classification and score>"}}]"""

    try:
        resp = client.chat.completions.create(
            model=settings.grader_model,
            messages=[{"role": "user", "content": classification_prompt}],
            temperature=0,
            max_tokens=800,
        )
        raw = resp.choices[0].message.content or ""
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip())
        classifications = json.loads(raw)
        rows = query(
            "SELECT id, ts FROM chat_exchanges WHERE session_id = ? ORDER BY ts",
            (session_id,),
        )
        for i, cls in enumerate(classifications):
            if i < len(rows):
                score_val = cls.get("score")
                if isinstance(score_val, (int, float)):
                    score_val = max(0, min(10, int(round(score_val))))
                else:
                    score_val = None
                execute(
                    "UPDATE chat_exchanges SET prompt_classification=?, prompt_score=?, prompt_reasoning=? WHERE id=?",
                    (cls.get("classification"), score_val, cls.get("reason"), rows[i]["id"]),
                )
    except Exception:
        classifications = []

    if not classifications:
        return {"score": 5, "reasoning": "Could not classify prompts."}

    counts = collections.Counter(
        c.get("classification") for c in classifications if isinstance(c, dict)
    )
    total = sum(counts.values()) or 1
    score = (counts["professional"] * 10 + counts["specific"] * 7 + counts["vague"] * 3) / total
    score = max(1, min(10, round(score)))

    total_tokens = signals.get("total_chat_tokens", 0) if signals else 0
    num_ex = signals.get("num_chat_exchanges", 0) if signals else 0
    avg_tokens_per_exchange = round(total_tokens / num_ex) if num_ex else 0

    commentary_prompt = f"""You are reviewing prompt quality for a coding interview candidate.

CLASSIFICATION BREAKDOWN:
- Professional prompts: {counts['professional']} ({counts['professional'] / total * 100:.0f}%)
- Specific prompts: {counts['specific']} ({counts['specific'] / total * 100:.0f}%)
- Vague prompts: {counts['vague']} ({counts['vague'] / total * 100:.0f}%)
- Total prompts evaluated: {total}

TOKEN USAGE:
- Total chat tokens spent across all exchanges: {total_tokens:,}
- Average tokens per exchange: {avg_tokens_per_exchange:,}

Write 2-3 sentences describing the candidate's prompting patterns based on the breakdown above (e.g., what mix of prompt types they used, what that suggests about their problem-isolation skill). Comment on whether their token spend looks productive given the prompt mix — vague prompts with high token spend is a negative signal; professional prompts that stayed lean is a positive one. Do not state a score."""

    reasoning = _commentary_call(
        client, commentary_prompt,
        "Prompt quality evaluated from classifications.",
        session_id,
    )
    return {"score": score, "reasoning": reasoning}


def _call(client: OpenAI, prompt: str, fallback_reasoning: str,
          session_id: str | None = None, stage: str | None = None,
          use_sc: bool = False) -> dict:
    n = settings.grader_self_consistency_n if use_sc else 1
    temps = _SC_TEMPERATURES[:n]

    run_results = []
    for temp in temps:
        result = _single_llm_call(client, prompt, temp, fallback_reasoning, session_id, stage)
        if result is not None:
            run_results.append(result)

    if not run_results:
        return {"score": _FALLBACK_SCORE, "reasoning": fallback_reasoning}

    if len(run_results) == 1:
        r = run_results[0]
        return {"score": r["score"], "reasoning": r["analysis"]}

    scores = [r["score"] for r in run_results]
    score = int(statistics.median(scores))
    score = max(1, min(10, score))
    analyses = " | ".join(f"[run {i+1}] {r['analysis']}" for i, r in enumerate(run_results))
    return {"score": score, "reasoning": analyses}


def _single_llm_call(client: OpenAI, prompt: str, temperature: float,
                      fallback_reasoning: str, session_id: str | None,
                      stage: str | None) -> dict | None:
    for attempt in range(2):
        attempt_temp = temperature if attempt == 0 else 0.3
        try:
            resp = client.chat.completions.create(
                model=settings.grader_model,
                messages=[{"role": "user", "content": prompt}],
                temperature=attempt_temp,
                max_tokens=600,
                response_format={"type": "json_object"},
            )
            text = resp.choices[0].message.content or ""
            text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
            data = json.loads(text)
            score = _coerce_score(data["score"])
            analysis = str(data.get("analysis") or data.get("reasoning", ""))
            return {"score": score, "analysis": analysis}
        except json.JSONDecodeError:
            if attempt == 0 and session_id and stage:
                try:
                    execute(
                        "INSERT INTO grading_errors (session_id, ts, user_message, stage, error_class, traceback) "
                        "VALUES (?, ?, ?, ?, ?, ?)",
                        (
                            session_id, int(time.time() * 1000),
                            f"{fallback_reasoning} (JSON parse failed, retrying)",
                            f"{stage}.parse_retry", "JSONDecodeError", traceback.format_exc(),
                        ),
                    )
                except Exception:
                    pass
            continue
        except Exception as e:
            if session_id and stage:
                try:
                    execute(
                        "INSERT INTO grading_errors (session_id, ts, user_message, stage, error_class, traceback) "
                        "VALUES (?, ?, ?, ?, ?, ?)",
                        (
                            session_id, int(time.time() * 1000), fallback_reasoning, stage,
                            type(e).__name__, traceback.format_exc(),
                        ),
                    )
                except Exception:
                    pass
            return None
    return None


def _commentary_call(client: OpenAI, prompt: str, fallback: str,
                      session_id: str | None = None) -> str:
    try:
        resp = client.chat.completions.create(
            model=settings.grader_model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            max_tokens=200,
        )
        return resp.choices[0].message.content or fallback
    except Exception:
        return fallback


def _read_file(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return ""


def _read_submission(clone_dir: Path, submission_files: list) -> str:
    if not submission_files:
        return ""
    parts = []
    for rel in submission_files:
        content = _read_file(clone_dir / rel)
        if content:
            parts.append(f"// ===== {rel} =====\n{content}")
    return "\n\n".join(parts)


def _read_chat_log(clone_dir: Path) -> list:
    path = clone_dir / ".jivahire_chat_log.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
