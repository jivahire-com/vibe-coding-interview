import os
import time
import uuid
import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from vibe.auth import check_rate_limit, get_session
from vibe.config import settings
from vibe.db import execute, query
from vibe.email import send_invite
from vibe.models import (
    CreateSessionRequest,
    ValidateSessionRequest,
    ValidateSessionResponse,
)

router = APIRouter(prefix="/api/v1")


@router.get("/sessions")
def list_sessions(x_admin_token: str = Header(None)):
    if x_admin_token != settings.admin_token:
        raise HTTPException(403, "Forbidden")
    rows = query(
        "SELECT s.id, s.session_key, s.candidate_email, s.challenge_id, s.status, "
        "s.llm_spent_usd, s.llm_budget_usd, s.max_minutes, "
        "s.typed_chars, s.pasted_chars, s.ai_applied_chars, "
        "s.created_at, s.started_at, s.submitted_at, "
        "g.total_score "
        "FROM sessions s LEFT JOIN grades g ON g.session_id = s.id "
        "ORDER BY s.created_at DESC"
    )
    return {"sessions": [dict(r) for r in rows]}


@router.get("/challenges")
def list_challenges(x_admin_token: str = Header(None)):
    if x_admin_token != settings.admin_token:
        raise HTTPException(403, "Forbidden")
    challenges_path = settings.challenges_dir
    try:
        entries = [
            d for d in os.listdir(challenges_path)
            if os.path.isdir(os.path.join(challenges_path, d)) and not d.startswith(".")
        ]
    except FileNotFoundError:
        entries = []
    return {"challenges": sorted(entries)}


@router.post("/sessions", status_code=201)
async def create_session(req: CreateSessionRequest, x_admin_token: str = Header(None)):
    if x_admin_token != settings.admin_token:
        raise HTTPException(403, "Forbidden")
    session_id = uuid.uuid4().hex
    branch = f"interview/{session_id}"
    execute(
        "INSERT INTO sessions "
        "(id, session_key, candidate_email, challenge_id, branch_name, llm_budget_usd, max_minutes) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (session_id, req.session_key, req.candidate_email, req.challenge_id,
         branch, req.llm_budget_usd, req.max_minutes),
    )
    try:
        await send_invite(
            req.candidate_email, req.session_key, req.challenge_id,
            req.max_minutes, req.llm_budget_usd,
        )
    except Exception:
        pass
    return {"session_id": session_id, "branch": branch}


@router.post("/validate-session", response_model=ValidateSessionResponse)
async def validate_session(req: ValidateSessionRequest, request: Request):
    ip = request.client.host
    check_rate_limit(ip)

    rows = query("SELECT * FROM sessions WHERE session_key = ?", (req.session_key,))
    if not rows:
        raise HTTPException(404, "Session not found")

    session = rows[0]
    if session["status"] not in ("pending", "active"):
        raise HTTPException(409, f"Session is {session['status']}")

    if session["status"] == "pending":
        await _create_github_branch(session["branch_name"])
        execute(
            "UPDATE sessions SET status='active', started_at=? WHERE id=?",
            (int(time.time()), session["id"]),
        )

    repo_url = f"https://github.com/{settings.github_challenges_repo}"
    return ValidateSessionResponse(
        session_id=session["id"],
        repo_url=repo_url,
        branch=session["branch_name"],
        github_clone_token=settings.github_bot_pat,
        llm_proxy_url=str(request.base_url).rstrip("/"),
        max_minutes=session["max_minutes"],
        llm_budget_usd=session["llm_budget_usd"],
        challenge_id=session["challenge_id"],
        chat_model=settings.chat_model,
    )


@router.get("/sessions/{session_id}")
def get_session_detail(session_id: str, x_admin_token: str = Header(None)):
    if x_admin_token != settings.admin_token:
        raise HTTPException(403, "Forbidden")
    rows = query("SELECT * FROM sessions WHERE id = ?", (session_id,))
    if not rows:
        raise HTTPException(404, "Not found")
    grades = query("SELECT * FROM grades WHERE session_id = ?", (session_id,))
    exchanges = query(
        "SELECT ts, prompt_tokens, completion_tokens, cached_input_tokens, reasoning_tokens, "
        "cost_usd, prompt_classification FROM chat_exchanges "
        "WHERE session_id = ? ORDER BY ts",
        (session_id,),
    )
    return {
        "session": rows[0],
        "grade": grades[0] if grades else None,
        "chat_exchanges": exchanges,
    }


async def _create_github_branch(branch_name: str) -> None:
    headers = {
        "Authorization": f"Bearer {settings.github_bot_pat}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    repo = settings.github_challenges_repo
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"https://api.github.com/repos/{repo}/git/ref/heads/main",
            headers=headers,
        )
        if r.status_code != 200:
            raise HTTPException(502, f"GitHub: could not get main SHA: {r.text}")
        sha = r.json()["object"]["sha"]

        r = await client.post(
            f"https://api.github.com/repos/{repo}/git/refs",
            headers=headers,
            json={"ref": f"refs/heads/{branch_name}", "sha": sha},
        )
        if r.status_code not in (201, 422):  # 422 = branch already exists
            raise HTTPException(502, f"GitHub: could not create branch: {r.text}")
