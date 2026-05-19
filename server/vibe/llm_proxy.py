import asyncio
import json
import re
import time
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from openai import AsyncOpenAI
from vibe.auth import get_session
from vibe.budget import compute_cost, OUTPUT_USD_PER_M
from vibe.challenge_context import get_challenge_context
from vibe.config import settings
from vibe.db import execute, query
from vibe.models import ChatRequest

router = APIRouter(prefix="/api/v1/llm")


def _get_client() -> AsyncOpenAI:
    return AsyncOpenAI(api_key=settings.openai_api_key, base_url=settings.llm_base_url)


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


@router.post("/chat/completions")
async def chat_completions(req: ChatRequest, session=Depends(get_session)):
    if session["status"] != "active":
        raise HTTPException(403, f"Session is {session['status']}")

    rows = query(
        "SELECT llm_spent_usd, llm_budget_usd, challenge_id FROM sessions WHERE id=?",
        (session["id"],),
    )
    spent = rows[0]["llm_spent_usd"]
    budget = rows[0]["llm_budget_usd"]
    challenge_id = rows[0]["challenge_id"]

    if spent >= budget:
        raise HTTPException(402, {"error": "budget_exhausted", "spent": spent, "budget": budget})

    remaining = budget - spent

    allowed_models = [m.strip() for m in settings.candidate_chat_models.split(",")]
    if req.model:
        if req.model not in allowed_models:
            raise HTTPException(400, f"Model {req.model!r} is not in the allowed list")
        model_to_use = req.model
    else:
        model_to_use = settings.chat_model

    base_instructions = (
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

    repo_dump = get_challenge_context(challenge_id)
    if repo_dump:
        system_content = (
            base_instructions
            + "\n\n# Challenge Repository (initial state)\n"
            "The candidate is working in a workspace containing the files below. "
            "This is the INITIAL state of the repo. If the user attaches a "
            '"Current contents of <path>" block in their message, treat that as '
            "the latest version of that file and prefer it over the copy here.\n\n"
            + repo_dump
        )
    else:
        system_content = base_instructions

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
                        # Byte-based heuristic: 4 chars ≈ 1 token (no tokenizer)
                        running_completion += len(delta.content) // 4
                        running_cost = running_completion / 1_000_000 * OUTPUT_USD_PER_M * 1.5
                        if running_cost > remaining:
                            yield f"data: {json.dumps({'error': 'budget_exhausted_midstream', 'code': 402})}\n\n"
                            yield "data: [DONE]\n\n"
                            aborted = True
                            break

            if not aborted:
                yield "data: [DONE]\n\n"

        finally:
            if prompt_tokens > 0 or completion_tokens > 0:
                cost = compute_cost(prompt_tokens, completion_tokens, cached_input_tokens)
                await asyncio.to_thread(
                    _record_exchange,
                    session["id"],
                    model_to_use,
                    prompt_tokens,
                    completion_tokens,
                    cached_input_tokens,
                    reasoning_tokens,
                    prompt_text,
                    cost,
                    aborted,
                )

    return StreamingResponse(generate(), media_type="text/event-stream")


def _record_exchange(
    session_id: str,
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    cached_input_tokens: int,
    reasoning_tokens: int,
    prompt_text: str,
    cost: float,
    aborted: bool,
) -> None:
    execute(
        "UPDATE sessions SET llm_spent_usd = llm_spent_usd + ? WHERE id=?",
        (cost, session_id),
    )
    execute(
        "INSERT INTO chat_exchanges "
        "(session_id, ts, model, prompt_tokens, completion_tokens, cost_usd, aborted_over_budget, "
        "cached_input_tokens, reasoning_tokens, prompt_text) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            session_id, int(time.time() * 1000), model,
            prompt_tokens, completion_tokens, cost, int(aborted),
            cached_input_tokens, reasoning_tokens, prompt_text,
        ),
    )
