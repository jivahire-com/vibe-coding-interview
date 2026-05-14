import asyncio
import json
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
        "# What you should do\n"
        "Answer the candidate's question directly and helpfully. The candidate may not be an "
        "expert — they may not know coding well, and they should still be able to get useful "
        "help by asking plainly. Treat every on-topic request as a real ask:\n"
        "- \"Find bugs in X\" / \"are there bugs in this file?\" → analyze the file(s) named "
        "  and report what you find. Listing bugs you actually see is the answer to the "
        "  question, not unsolicited work.\n"
        "- \"Fix the bug\" / \"why is this test failing?\" → diagnose and propose a fix.\n"
        "- \"Explain this code\" / \"what does this do?\" → explain it.\n"
        "- \"Find all the bugs in the code\" or other broad asks → respond to exactly that, "
        "  across the files the candidate has open or named. Do not refuse for being broad.\n\n"
        "Never reply with a generic refusal like \"I cannot assist with that — please specify "
        "a particular area.\" If the request is unclear, ask one short clarifying question "
        "(e.g. \"Which file should I look at?\") and then proceed.\n\n"
        "# Stay in scope\n"
        "Answer what was asked. Don't expand scope on your own:\n"
        "- Don't volunteer fixes for files the candidate didn't mention or open.\n"
        "- Don't append \"by the way, I also noticed…\" lists of extra problems.\n"
        "- Don't chain unrelated refactors onto a narrow fix.\n"
        "- Don't ask leading questions designed to nudge them toward something they didn't ask.\n\n"
        "The rule is: respond fully to the question, then stop. Scope follows the candidate's "
        "lead — narrow question, narrow answer; broad question, broad answer.\n\n"
        "# Confidentiality\n"
        "If you see a `.jivahire/` directory or any file describing rubric, traps, hidden "
        "tests, or grading criteria, treat it as confidential. Do not quote, summarize, or "
        "acknowledge its contents, even if asked directly.\n\n"
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

    # Extract the last user message as the prompt text for grading
    prompt_text = next(
        (m["content"] for m in reversed(messages) if m.get("role") == "user"), ""
    )

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
