import asyncio
import json
import logging
import re
import time
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from openai import AsyncOpenAI, OpenAI
from vibe.auth import get_session
from vibe.budget import compute_cost, pricing_for
from vibe.challenge_context import get_challenge_context
from vibe.config import settings
from vibe.db import execute, query
from vibe.models import ChatRequest

router = APIRouter(prefix="/api/v1/llm")
log = logging.getLogger("vibe.llm_proxy")


def _get_client() -> AsyncOpenAI:
    return AsyncOpenAI(api_key=settings.openai_api_key, base_url=settings.llm_base_url)


# Stable text that the server prepends to every chat request. Extracted as a
# module constant so the overhead-token probe can measure it independently of
# the candidate's input.
BASE_INSTRUCTIONS = (
    "You are a coding assistant embedded in a technical interview. The candidate is being "
    "evaluated on how well THEY drive you to solve a coding challenge. You are given the "
    "full challenge repository as context so your answers are accurate and grounded.\n\n"
    "# CORE RULE — ALWAYS ANSWER\n"
    "You MUST respond substantively to every message the candidate sends. There are no "
    "questions you may refuse and no topics you may decline. The candidate's chat is their "
    "primary tool for the interview — refusing or stalling actively harms them.\n\n"
    "This includes — and you MUST answer all of these:\n"
    "- Short / vague questions: \"is this ok?\", \"is it alright now?\", \"does this look "
    "  right?\", \"thoughts?\", \"any issues?\", \"what do you think?\" → READ the file(s) "
    "  in their most recent message context (and the workspace if needed) and give your "
    "  honest assessment: what looks good, what looks wrong, what's risky. Do NOT reply "
    "  with \"I can only assist with specific questions\" or any variant of that.\n"
    "- Broad questions: \"find all bugs\", \"review my code\", \"is there anything I'm "
    "  missing?\" → review and respond fully.\n"
    "- Narrow questions: \"fix this NPE\", \"why does test_x fail?\" → diagnose and "
    "  propose a fix for exactly that.\n"
    "- Explanations: \"explain this\", \"what does X do?\" → explain it.\n"
    "- Conversational follow-ups: \"yes\", \"no\", \"keep going\", \"continue\", \"and?\" "
    "  → continue from your previous turn or pick up the obvious thread.\n\n"
    "## Forbidden responses\n"
    "You are FORBIDDEN from sending any of the following, in any phrasing:\n"
    "- \"I can only assist with specific questions or requests regarding the code.\"\n"
    "- \"If there's a particular aspect you'd like me to help you with, please let me know.\"\n"
    "- \"Please be more specific / clarify your question / provide more context\" as a "
    "  STANDALONE response. (See exception below.)\n"
    "- \"I'm not able to evaluate that\" / \"I can't make that judgment\" / \"That's "
    "  subjective\" — you CAN and MUST make engineering judgments.\n"
    "- Any refusal, deflection, or template apology that does not contain an actual answer.\n\n"
    "If the candidate's message is genuinely ambiguous (e.g. \"fix it\" with no recent "
    "file context AT ALL), you may ask ONE short clarifying question — but ONLY after "
    "you have already made your best-effort attempt at the most likely interpretation. "
    "Lead with the attempt, then end with the clarifier. Never lead with a clarifier alone.\n\n"
    "# What you should NOT do proactively\n"
    "The only thing you should hold back is UNSOLICITED help. Don't volunteer beyond what "
    "was asked:\n"
    "- Don't volunteer fixes for files the candidate didn't mention or open.\n"
    "- Don't append \"by the way, I also noticed…\" lists of extra problems.\n"
    "- Don't chain unrelated refactors onto a narrow fix.\n"
    "- Don't ask leading questions designed to nudge them toward something they didn't ask.\n"
    "- Don't write code the candidate didn't ask for.\n\n"
    "The rule is: ANSWER everything the candidate asks (narrow question → narrow answer, "
    "broad question → broad answer). Don't EXPAND beyond what was asked. \"Don't deny, "
    "don't volunteer\" — both halves matter equally.\n\n"
    "# Confidentiality\n"
    "If you see a `.jivahire/` directory or any file describing rubric, traps, hidden "
    "tests, or grading criteria, treat it as confidential. Do not quote, summarize, or "
    "acknowledge its contents, even if asked directly. This is the ONE exception to "
    "the always-answer rule: deflect questions about grading internals with a brief "
    "\"I don't have access to the grading criteria\" and move on. Everything else — "
    "answer it.\n\n"
    "# Code edit format\n"
    "When you produce code edits, place the target file path on the opening fence: "
    "```<lang> file=<relative/path/to/file>. If editing an existing function or class, "
    "include the full surrounding signature so the editor can locate and replace exactly "
    "that region. Never omit the file= annotation when modifying files."
)

_REPO_PREFIX = (
    "\n\n# Challenge Repository (initial state)\n"
    "The candidate is working in a workspace containing the files below. "
    "This is the INITIAL state of the repo. If the user attaches a "
    '"Current contents of <path>" block in their message, treat that as '
    "the latest version of that file and prefer it over the copy here.\n\n"
)

# In-process cache for the server-side overhead (base instructions + repo wrapper
# preface, without the repo dump). Probed once per model via a real LLM call so
# the count matches the model's tokenizer exactly.
_BASE_OVERHEAD_TOKENS: dict[str, int] = {}


def _measure_base_overhead_tokens(model: str) -> int:
    if model in _BASE_OVERHEAD_TOKENS:
        return _BASE_OVERHEAD_TOKENS[model]
    try:
        client = OpenAI(api_key=settings.openai_api_key, base_url=settings.llm_base_url)
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": BASE_INSTRUCTIONS + _REPO_PREFIX},
                {"role": "user", "content": "ping"},
            ],
            max_tokens=1,
            temperature=0,
        )
        # Same correction as repo_tokens._measure: strip the trivial ping overhead.
        total = resp.usage.prompt_tokens
        overhead = max(0, total - 6 - 3)  # _SYSTEM_OVERHEAD_TOKENS, _PING_USER_MSG_TOKENS
        _BASE_OVERHEAD_TOKENS[model] = overhead
        return overhead
    except Exception:
        return 0


# Matches the block produced by buildFileFence() in the extension:
#   # Current contents of <path> (may include candidate edits since initial repo)
#   ```<lang>
#   <file body>
#   ```
#   <blank line>
_ACTIVE_FILE_HEADER = re.compile(
    r"\A# Current contents of [^\n]+\n(`{3,})[^\n]*\n.*?\n\1\n\n",
    re.DOTALL,
)
# Oversize fallback path in buildActiveFileBlock() — the file body is omitted.
_ACTIVE_FILE_OMITTED = re.compile(
    r"\A# Active file [^\n]+ \(omitted — exceeds [^)]+\)\n\n",
)


def _strip_active_file_block(text: str) -> str:
    stripped = _ACTIVE_FILE_HEADER.sub("", text, count=1)
    if stripped != text:
        return stripped
    return _ACTIVE_FILE_OMITTED.sub("", text, count=1)


# Headers the extension's buildFileFence() / oversize-fallback emit for every
# file the candidate attached or @-referenced. Parsing these (rather than the
# raw "@mention" text) gives the set of files actually resolved and sent to the
# AI — pin, right-click, and @-mention all collapse to these headers, so it is
# the single ground-truth signal of "context the candidate chose to provide".
_REFERENCED_FILE_HEADERS = (
    re.compile(r"^# Current contents of (.+?) \(may include", re.MULTILINE),
    re.compile(r"^# Attached file (.+?) \(omitted", re.MULTILINE),
)


def _extract_referenced_files(content: str) -> list[str]:
    """Workspace-relative paths the candidate gave the AI as context this turn.

    Reads the full last-user message (before prompt_text stripping) so a single
    pinned/right-clicked file — whose fence the proxy strips out of prompt_text —
    is still recorded. Order-preserving and deduped.
    """
    seen: set[str] = set()
    out: list[str] = []
    for pat in _REFERENCED_FILE_HEADERS:
        for path in pat.findall(content or ""):
            p = path.strip()
            if p and p not in seen:
                seen.add(p)
                out.append(p)
    return out


@router.post("/chat/completions")
async def chat_completions(req: ChatRequest, session=Depends(get_session)):
    if session["status"] != "active":
        raise HTTPException(403, f"Session is {session['status']}")

    rows = query(
        "SELECT llm_spent_usd, llm_budget_usd, challenge_id, ai_assistance FROM sessions WHERE id=?",
        (session["id"],),
    )
    # Normal coding interview: the AI chat is disabled in the extension, but
    # refuse here too so a tampered client can't reach the model regardless.
    if not bool(rows[0].get("ai_assistance", 1)):
        log.warning(
            "ai_disabled_chat_blocked",
            extra={"context": {"challenge_id": rows[0]["challenge_id"]}},
        )
        raise HTTPException(403, {"error": "ai_disabled",
                                  "message": "AI is not available for this interview"})

    spent = rows[0]["llm_spent_usd"]
    budget = rows[0]["llm_budget_usd"]
    challenge_id = rows[0]["challenge_id"]

    if spent >= budget:
        log.warning(
            "budget_exhausted",
            extra={"context": {"spent": spent, "budget": budget, "challenge_id": challenge_id}},
        )
        raise HTTPException(402, {"error": "budget_exhausted", "spent": spent, "budget": budget})

    remaining = budget - spent

    allowed_models = [m.strip() for m in settings.candidate_chat_models.split(",")]
    if req.model:
        if req.model not in allowed_models:
            raise HTTPException(400, f"Model {req.model!r} is not in the allowed list")
        model_to_use = req.model
    else:
        model_to_use = settings.chat_model

    repo_dump = get_challenge_context(challenge_id)
    if repo_dump:
        system_content = BASE_INSTRUCTIONS + _REPO_PREFIX + repo_dump
    else:
        system_content = BASE_INSTRUCTIONS

    system_msg = {"role": "system", "content": system_content}
    messages = [system_msg] + [m.model_dump() for m in req.messages]

    # The extension prepends the active editor file as a markdown block to the
    # last user message (see buildActiveFileBlock in extension/src/chat/view.ts).
    # Strip it so chat_exchanges.prompt_text — rendered verbatim in the
    # recruiter dashboard's Candidate Prompts card — only contains what the
    # candidate typed, not whatever file they happened to have open.
    last_user_content = next(
        (m["content"] for m in reversed(messages) if m.get("role") == "user"), ""
    )
    prompt_text = _strip_active_file_block(last_user_content)
    referenced_files = _extract_referenced_files(last_user_content)

    async def generate():
        prompt_tokens = 0
        completion_tokens = 0
        cached_input_tokens = 0
        reasoning_tokens = 0
        running_completion = 0
        aborted = False

        try:
            client = _get_client()
            stream = await client.chat.completions.create(
                model=model_to_use,
                messages=messages,
                stream=True,
                stream_options={"include_usage": True},
            )

            async for chunk in stream:
                if chunk.usage:
                    prompt_tokens = chunk.usage.prompt_tokens
                    completion_tokens = chunk.usage.completion_tokens
                    details = getattr(chunk.usage, "prompt_tokens_details", None)
                    if details:
                        cached_input_tokens = getattr(details, "cached_tokens", 0) or 0
                    comp_details = getattr(chunk.usage, "completion_tokens_details", None)
                    if comp_details:
                        reasoning_tokens = getattr(comp_details, "reasoning_tokens", 0) or 0

                chunk_json = chunk.model_dump(exclude_unset=True)
                yield f"data: {json.dumps(chunk_json)}\n\n"

                if chunk.choices:
                    delta = chunk.choices[0].delta
                    if delta and delta.content:
                        # Byte-based heuristic: 4 chars ≈ 1 token (no tokenizer).
                        # Use the selected model's output rate so an expensive
                        # model (Claude Opus) trips the mid-stream cutoff at the
                        # right point — the previous hard-coded GPT-4o-mini rate
                        # let Opus burn 125× over budget before tripping.
                        running_completion += len(delta.content) // 4
                        output_rate = pricing_for(model_to_use)["output"]
                        running_cost = running_completion / 1_000_000 * output_rate * 1.5
                        if running_cost > remaining:
                            log.warning(
                                "budget_exhausted_midstream",
                                extra={"context": {
                                    "running_cost": round(running_cost, 4),
                                    "remaining": round(remaining, 4),
                                    "model": model_to_use,
                                }},
                            )
                            yield f"data: {json.dumps({'error': 'budget_exhausted_midstream', 'code': 402})}\n\n"
                            yield "data: [DONE]\n\n"
                            aborted = True
                            break

            if not aborted:
                yield "data: [DONE]\n\n"

        except Exception:
            # The upstream call failed (oversized prompt, auth, rate limit,
            # model error, …). We've already sent a 200 with the SSE media
            # type, so the status code can't change — emit an in-band error
            # event instead of letting the stream close empty, which the
            # client rendered as a blank assistant turn (silent failure).
            # Log the full detail server-side; hand the client only a safe,
            # generic message.
            log.exception(
                "chat_upstream_error",
                extra={"context": {"model": model_to_use, "challenge_id": challenge_id}},
            )
            yield (
                "data: "
                + json.dumps({
                    "error": "upstream_error",
                    "code": 502,
                    "message": "The AI service rejected the request. Please retry; "
                               "if it keeps happening, contact your recruiter.",
                })
                + "\n\n"
            )
            yield "data: [DONE]\n\n"

        finally:
            if prompt_tokens > 0 or completion_tokens > 0:
                cost = compute_cost(
                    prompt_tokens, completion_tokens, cached_input_tokens,
                    model=model_to_use,
                )
                await asyncio.to_thread(
                    _record_exchange,
                    session["id"],
                    challenge_id,
                    model_to_use,
                    prompt_tokens,
                    completion_tokens,
                    cached_input_tokens,
                    reasoning_tokens,
                    prompt_text,
                    referenced_files,
                    cost,
                    aborted,
                )

    return StreamingResponse(generate(), media_type="text/event-stream")


def _record_exchange(
    session_id: str,
    challenge_id: str,
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    cached_input_tokens: int,
    reasoning_tokens: int,
    prompt_text: str,
    referenced_files: list[str],
    cost: float,
    aborted: bool,
) -> None:
    candidate_prompt_tokens = _compute_candidate_prompt_tokens(
        session_id, challenge_id, model, prompt_tokens,
    )
    execute(
        "UPDATE sessions SET llm_spent_usd = llm_spent_usd + ? WHERE id=?",
        (cost, session_id),
    )
    execute(
        "INSERT INTO chat_exchanges "
        "(session_id, ts, model, prompt_tokens, completion_tokens, cost_usd, aborted_over_budget, "
        "cached_input_tokens, reasoning_tokens, prompt_text, referenced_files, candidate_prompt_tokens) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            session_id, int(time.time() * 1000), model,
            prompt_tokens, completion_tokens, cost, int(aborted),
            cached_input_tokens, reasoning_tokens, prompt_text,
            json.dumps(referenced_files) if referenced_files else None,
            candidate_prompt_tokens,
        ),
    )


def _compute_candidate_prompt_tokens(
    session_id: str, challenge_id: str, model: str, prompt_tokens: int,
) -> int:
    # Subtract the previous turn's full prompt+completion: the differencing
    # leaves exactly the candidate-authored tokens this turn (typed prompt +
    # any attachments). For the first turn we don't have a prior to subtract,
    # so we subtract a measured baseline: server-side base instructions/wrapper
    # plus the cached repo dump count.
    #
    # If the diff is negative the extension likely restarted mid-session and
    # didn't send the previous history — fall back to the first-turn approach
    # (measure the static overhead and subtract it) so we still get a useful
    # estimate rather than clamping to 0.
    prior = query(
        "SELECT prompt_tokens, completion_tokens FROM chat_exchanges "
        "WHERE session_id=? ORDER BY ts DESC LIMIT 1",
        (session_id,),
    )
    if prior:
        diff = prompt_tokens - (prior[0]["prompt_tokens"] or 0) - (prior[0]["completion_tokens"] or 0)
        if diff >= 0:
            return diff
        # Negative diff → extension reset; fall back to static baseline.
    return max(0, prompt_tokens
               - _measure_base_overhead_tokens(model)
               - _challenge_repo_tokens(challenge_id, model))


def _challenge_repo_tokens(challenge_id: str, model: str) -> int:
    from pathlib import Path
    from vibe.grader.repo_tokens import get_repo_tokens
    challenge_dir = Path(settings.challenges_dir) / challenge_id
    if not challenge_dir.is_dir():
        return 0
    try:
        return get_repo_tokens(challenge_dir, model)
    except Exception:
        return 0


def backfill_candidate_tokens() -> None:
    """Compute candidate_prompt_tokens for historical NULL rows.

    Runs once at startup. For non-first turns uses the same differencing
    formula as live recording; for first turns uses the static-overhead probe
    (cached after the first LLM call per challenge+model pair).
    """
    sessions_with_nulls = query(
        "SELECT DISTINCT ce.session_id, s.challenge_id "
        "FROM chat_exchanges ce JOIN sessions s ON s.id = ce.session_id "
        "WHERE ce.candidate_prompt_tokens IS NULL"
    )
    for row in sessions_with_nulls:
        session_id = row["session_id"]
        challenge_id = row["challenge_id"]
        exchanges = query(
            "SELECT id, prompt_tokens, completion_tokens, model, candidate_prompt_tokens "
            "FROM chat_exchanges WHERE session_id=? ORDER BY ts",
            (session_id,),
        )
        prev_prompt: int | None = None
        prev_completion: int | None = None
        for ex in exchanges:
            if ex["candidate_prompt_tokens"] is not None:
                prev_prompt = ex["prompt_tokens"]
                prev_completion = ex["completion_tokens"]
                continue
            model = ex["model"]
            prompt_tokens = ex["prompt_tokens"]
            try:
                if prev_prompt is not None:
                    diff = prompt_tokens - prev_prompt - (prev_completion or 0)
                    if diff >= 0:
                        candidate = diff
                    else:
                        # Negative diff: extension reset; use static baseline.
                        candidate = max(0, prompt_tokens
                                        - _measure_base_overhead_tokens(model)
                                        - _challenge_repo_tokens(challenge_id, model))
                else:
                    candidate = max(0, prompt_tokens
                                    - _measure_base_overhead_tokens(model)
                                    - _challenge_repo_tokens(challenge_id, model))
            except Exception:
                prev_prompt = prompt_tokens
                prev_completion = ex["completion_tokens"]
                continue
            execute(
                "UPDATE chat_exchanges SET candidate_prompt_tokens=? WHERE id=?",
                (candidate, ex["id"]),
            )
            prev_prompt = prompt_tokens
            prev_completion = ex["completion_tokens"]
