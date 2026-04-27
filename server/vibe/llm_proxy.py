import asyncio
import json
import time
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from openai import AsyncOpenAI
from vibe.auth import get_session
from vibe.budget import MODEL, compute_cost, estimate_prompt_cost
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
        "SELECT llm_spent_usd, llm_budget_usd FROM sessions WHERE id=?",
        (session["id"],),
    )
    spent = rows[0]["llm_spent_usd"]
    budget = rows[0]["llm_budget_usd"]

    if spent >= budget:
        raise HTTPException(402, {"error": "budget_exhausted", "spent": spent, "budget": budget})

    messages = [m.model_dump() for m in req.messages]
    est = estimate_prompt_cost(messages)
    if spent + est > budget:
        raise HTTPException(402, {"error": "budget_exhausted", "spent": spent, "budget": budget})

    remaining = budget - spent

    async def generate():
        prompt_tokens = 0
        completion_tokens = 0
        running_completion = 0
        aborted = False

        try:
            client = _get_client()
            stream = await client.chat.completions.create(
                model=MODEL,
                messages=messages,
                stream=True,
                stream_options={"include_usage": True},
            )

            async for chunk in stream:
                if chunk.usage:
                    prompt_tokens = chunk.usage.prompt_tokens
                    completion_tokens = chunk.usage.completion_tokens

                chunk_json = chunk.model_dump(exclude_unset=True)
                yield f"data: {json.dumps(chunk_json)}\n\n"

                if chunk.choices:
                    delta = chunk.choices[0].delta
                    if delta and delta.content:
                        running_completion += len(delta.content) // 4
                        running_cost = compute_cost(
                            prompt_tokens or int(est / (0.15 / 1_000_000)),
                            running_completion,
                        )
                        if running_cost > remaining:
                            yield f"data: {json.dumps({'error': 'budget_exhausted_midstream', 'code': 402})}\n\n"
                            yield "data: [DONE]\n\n"
                            aborted = True
                            break

            if not aborted:
                yield "data: [DONE]\n\n"

        finally:
            if prompt_tokens > 0 or completion_tokens > 0:
                cost = compute_cost(prompt_tokens, completion_tokens)
                await asyncio.to_thread(
                    _record_exchange,
                    session["id"],
                    prompt_tokens,
                    completion_tokens,
                    cost,
                    aborted,
                )

    return StreamingResponse(generate(), media_type="text/event-stream")


def _record_exchange(
    session_id: str,
    prompt_tokens: int,
    completion_tokens: int,
    cost: float,
    aborted: bool,
) -> None:
    execute(
        "UPDATE sessions SET llm_spent_usd = llm_spent_usd + ? WHERE id=?",
        (cost, session_id),
    )
    execute(
        "INSERT INTO chat_exchanges "
        "(session_id, ts, model, prompt_tokens, completion_tokens, cost_usd, aborted_over_budget) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (session_id, int(time.time() * 1000), MODEL, prompt_tokens, completion_tokens, cost, int(aborted)),
    )
