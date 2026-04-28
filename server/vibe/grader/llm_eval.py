import json
import re
from pathlib import Path

from openai import OpenAI

from vibe.config import settings
from vibe.db import execute, query

_GRADER_MODEL = "openai/gpt-4o-mini"
_FALLBACK_SCORE = 5


def evaluate(session_id: str, challenge_id: str, test_results: dict, clone_dir: Path) -> dict:
    code = _read_file(clone_dir / "include" / "lru_cache.hpp")
    chat_log = _read_chat_log(clone_dir)
    rubric = _load_json(Path(settings.challenges_dir) / challenge_id / ".jivahire" / "rubric.json")
    traps = _load_json(Path(settings.challenges_dir) / challenge_id / ".jivahire" / "traps.json")

    client = OpenAI(api_key=settings.openai_api_key, base_url=settings.llm_base_url)

    cq = _eval_code_quality(client, code, test_results, rubric, traps)
    ao = _eval_ai_orchestration(client, code, chat_log)
    ar = _eval_architectural_reasoning(client, code, rubric)
    pq = _eval_prompt_quality(client, session_id, chat_log)
    te = _eval_token_efficiency(client, session_id, rubric)

    summary = (
        f"Code quality ({cq['score']}/10): {cq['reasoning']} | "
        f"AI orchestration ({ao['score']}/10): {ao['reasoning']} | "
        f"Architectural reasoning ({ar['score']}/10): {ar['reasoning']} | "
        f"Prompt quality ({pq['score']}/10): {pq['reasoning']} | "
        f"Token efficiency ({te['score']}/10): {te['reasoning']}"
    )

    return {
        "code_quality_score": cq["score"],
        "ai_orchestration_score": ao["score"],
        "architectural_reasoning_score": ar["score"],
        "prompt_quality_score": pq["score"],
        "token_efficiency_score": te["score"],
        "summary": summary,
    }


def _eval_code_quality(client, code: str, test_results: dict, rubric: dict, traps: dict) -> dict:
    passed = [tag for tag, ok in test_results.items() if ok]
    failed = [tag for tag, ok in test_results.items() if not ok]
    build_failed = not test_results

    prompt = f"""You are grading a C++ coding interview submission.

CHALLENGE: Implement a thread-safe LRU cache (get/put in O(1)).

RUBRIC TASKS:
{json.dumps(rubric.get('tasks', []), indent=2)}

KNOWN TRAPS (intentional bugs planted in the starter code):
{json.dumps(traps.get('traps', []), indent=2)}

TEST RESULTS:
- Build succeeded: {not build_failed}
- Passed tags: {passed or 'none'}
- Failed tags: {failed or 'none'}

CANDIDATE CODE:
```cpp
{code}
```

Score the code quality 1–10 based on:
- Correctness (does it pass the tests, fix the traps?)
- Thread safety (mutex/lock usage)
- C++ idioms (move semantics, const correctness, RAII)
- Clarity and naming

Respond with JSON only:
{{"score": <int 1-10>, "reasoning": "<2-3 sentences>"}}"""

    return _call(client, prompt, fallback_reasoning="Code quality could not be evaluated.")


def _eval_ai_orchestration(client, code: str, chat_log: list) -> dict:
    if not chat_log:
        return {"score": 5, "reasoning": "No AI chat exchanges recorded — unable to evaluate AI usage."}

    exchanges_text = "\n\n".join(
        f"[{i+1}] Candidate: {e.get('prompt_text','')}\n    AI: {e.get('response_text','')[:400]}"
        for i, e in enumerate(chat_log[:20])
    )

    prompt = f"""You are evaluating how effectively a candidate used AI assistance during a coding interview.

CANDIDATE'S AI CHAT EXCHANGES (up to 20 shown):
{exchanges_text}

FINAL CODE SUBMITTED:
```cpp
{code[:3000]}
```

Score AI orchestration 1–10 based on:
- Prompt quality (specific and targeted vs vague/generic)
- Whether the candidate understood and adapted AI suggestions rather than blindly copying
- Iterative refinement (did they follow up on problems?)
- Independence (evidence of own reasoning alongside AI use)

Respond with JSON only:
{{"score": <int 1-10>, "reasoning": "<2-3 sentences>"}}"""

    return _call(client, prompt, fallback_reasoning="AI orchestration could not be evaluated.")


def _eval_architectural_reasoning(client, code: str, rubric: dict) -> dict:
    prompt = f"""You are evaluating architectural understanding in a C++ coding interview.

CHALLENGE RUBRIC:
{json.dumps(rubric, indent=2)}

CANDIDATE CODE:
```cpp
{code}
```

Score architectural reasoning 1–10 based on:
- Correct algorithm choice (doubly-linked list + hash map for O(1) LRU)
- Data structure justification (why std::list + std::unordered_map)
- Concurrency design (mutex placement and granularity)
- Edge case awareness (capacity=0, eviction boundary conditions)

Respond with JSON only:
{{"score": <int 1-10>, "reasoning": "<2-3 sentences>"}}"""

    return _call(client, prompt, fallback_reasoning="Architectural reasoning could not be evaluated.")


def _eval_prompt_quality(client, session_id: str, chat_log: list) -> dict:
    if not chat_log:
        return {"score": 5, "reasoning": "No prompts to evaluate."}

    prompts = [e.get("prompt_text", "") for e in chat_log if e.get("prompt_text")]
    if not prompts:
        return {"score": 5, "reasoning": "No prompt text found in chat log."}

    # Step 1: classify each prompt and persist back to chat_exchanges
    classification_prompt = f"""Classify each candidate prompt as one of: vague, specific, professional.

Definitions:
- vague: generic requests without technical context, e.g. "fix this", "please fix this code", "make no mistake fix it", "build me this"
- specific: includes the problem or symptom but lacks technical precision, e.g. "the LRU cache isn't working"
- professional: cites exact errors, types, line numbers, constraints, or runtime behaviour, e.g. "the put() evicts the wrong key when capacity=1 because the iterator is invalidated before erase"

PROMPTS (numbered):
{chr(10).join(f"[{i+1}] {p[:300]}" for i, p in enumerate(prompts[:20]))}

Respond with JSON only — a list of objects in the same order:
[{{"index": 1, "classification": "vague|specific|professional", "reason": "<one line>"}}]"""

    try:
        resp = client.chat.completions.create(
            model=_GRADER_MODEL,
            messages=[{"role": "user", "content": classification_prompt}],
            temperature=0,
            max_tokens=800,
        )
        raw = resp.choices[0].message.content or ""
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip())
        classifications = json.loads(raw)
        # Persist classifications back to chat_exchanges using ts from chat_log
        rows = query(
            "SELECT id, ts FROM chat_exchanges WHERE session_id = ? ORDER BY ts",
            (session_id,),
        )
        for i, cls in enumerate(classifications):
            if i < len(rows):
                execute(
                    "UPDATE chat_exchanges SET prompt_classification=? WHERE id=?",
                    (cls.get("classification"), rows[i]["id"]),
                )
    except Exception:
        classifications = []

    # Step 2: aggregate score
    sample = "\n".join(
        f"[{i+1}] ({c.get('classification','?')}): {p[:200]}"
        for i, (p, c) in enumerate(zip(prompts[:10], classifications or [{}]*10))
    )
    score_prompt = f"""You are scoring the prompt quality of a candidate during a coding interview.

CANDIDATE PROMPTS WITH CLASSIFICATION:
{sample}

Score prompt quality 1–10:
- 9–10: Consistently professional — cites exact errors, types, constraints, runtime behaviour
- 7–8: Mostly specific — describes the problem clearly even if lacking precision
- 5–6: Mixed — some good prompts, some vague
- 3–4: Mostly vague — generic requests like "fix this" or "make it work"
- 1–2: All laymen — zero technical context, shows no understanding of the problem

Respond with JSON only:
{{"score": <int 1-10>, "reasoning": "<2-3 sentences>"}}"""

    return _call(client, score_prompt, fallback_reasoning="Prompt quality could not be evaluated.")


def _eval_token_efficiency(client, session_id: str, rubric: dict) -> dict:
    expected_tokens = rubric.get("expected_tokens", 30000)
    rows = query(
        "SELECT SUM(prompt_tokens + completion_tokens) AS total FROM chat_exchanges WHERE session_id=?",
        (session_id,),
    )
    actual_tokens = (rows[0]["total"] or 0) if rows else 0

    if actual_tokens == 0:
        return {"score": 5, "reasoning": "No token usage recorded — unable to evaluate token efficiency."}

    ratio = actual_tokens / expected_tokens if expected_tokens else 1.0

    prompt = f"""You are evaluating token efficiency for a coding interview.

CHALLENGE: Implement a thread-safe LRU cache in C++.
EXPECTED BASELINE TOKENS: {expected_tokens:,}
ACTUAL TOKENS USED: {actual_tokens:,}
RATIO (actual / expected): {ratio:.2f}x

Score token efficiency 1–10:
- 10: 0.5–1.5× baseline (optimal use)
- 8–9: 1.5–2× baseline (somewhat verbose but reasonable)
- 6–7: 0.3–0.5× baseline with good code quality (efficient), or 2–3× (over-prompted)
- 4–5: >3× baseline (excessive, repeated prompts, low signal), or <0.3× with poor code
- 1–3: >5× baseline (highly wasteful or near-zero tokens despite poor solution)

Consider: did they use AI effectively or spam prompts? Was the token spend proportional to the problem difficulty?

Respond with JSON only:
{{"score": <int 1-10>, "reasoning": "<2-3 sentences>"}}"""

    return _call(client, prompt, fallback_reasoning="Token efficiency could not be evaluated.")


def _call(client: OpenAI, prompt: str, fallback_reasoning: str) -> dict:
    try:
        resp = client.chat.completions.create(
            model=_GRADER_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            max_tokens=300,
        )
        text = resp.choices[0].message.content or ""
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
        data = json.loads(text)
        score = max(1, min(10, int(data["score"])))
        return {"score": score, "reasoning": str(data.get("reasoning", ""))}
    except Exception as e:
        return {"score": _FALLBACK_SCORE, "reasoning": f"{fallback_reasoning} (error: {e})"}


def _read_file(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return ""


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
