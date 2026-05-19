import json
import os
import sqlite3
import time
import uuid
import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from vibe.auth import check_rate_limit, get_session
from vibe.config import repo_for_challenge, settings
from vibe.db import execute, query
from vibe.email import send_invite, send_panelist_invite
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
        "s.meet_link, s.video_platform, s.scheduled_at, s.panelist_emails, "
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
        entries = sorted(
            d for d in os.listdir(challenges_path)
            if os.path.isdir(os.path.join(challenges_path, d)) and not d.startswith(".")
        )
    except FileNotFoundError:
        entries = []

    items: list[dict] = []
    for cid in entries:
        meta_path = os.path.join(challenges_path, cid, ".jivahire", "metadata.json")
        meta: dict = {}
        try:
            with open(meta_path, "r", encoding="utf-8") as fh:
                meta = json.load(fh)
        except (OSError, ValueError):
            meta = {}
        status = meta.get("status", "active")
        # Per CHALLENGE_AUTHORING.md §1, drafts are never assignable to candidates.
        if status == "draft":
            continue
        items.append({
            "id": cid,
            "title": meta.get("title") or cid,
            "language": meta.get("language") or "unknown",
            "difficulty": meta.get("difficulty") or "unknown",
            "estimated_minutes": meta.get("estimated_minutes"),
            "max_minutes": meta.get("max_minutes"),
            "tags": meta.get("tags") or [],
        })

    # Backwards-compatible: keep flat string list of ids alongside rich items.
    return {
        "challenges": [c["id"] for c in items],
        "items": items,
    }


@router.post("/sessions", status_code=201)
@router.post("/admin/invites", status_code=201)
async def create_session(req: CreateSessionRequest, x_admin_token: str = Header(None)):
    if x_admin_token != settings.admin_token:
        raise HTTPException(403, "Forbidden")

    # Reject draft challenges — they have no grader runner wired and must not be
    # assigned to candidates (CHALLENGE_AUTHORING.md §1).
    meta_path = os.path.join(
        settings.challenges_dir, req.challenge_id, ".jivahire", "metadata.json"
    )
    try:
        with open(meta_path, "r", encoding="utf-8") as fh:
            meta = json.load(fh)
    except FileNotFoundError:
        raise HTTPException(404, f"Unknown challenge '{req.challenge_id}'")
    except (OSError, ValueError):
        meta = {}
    if meta.get("status") == "draft":
        raise HTTPException(
            409, f"Challenge '{req.challenge_id}' is a draft and cannot be assigned"
        )

    session_id = uuid.uuid4().hex
    branch = f"interview/{session_id}"
    # Store the panel list as a CSV string in SQLite. Pydantic has already
    # normalised it to a deduplicated, lowercase list with no whitespace.
    panelists_csv = ",".join(req.panelist_emails) if req.panelist_emails else None
    try:
        execute(
            "INSERT INTO sessions "
            "(id, session_key, candidate_email, challenge_id, branch_name, "
            "llm_budget_usd, max_minutes, meet_link, video_platform, "
            "scheduled_at, panelist_emails) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (session_id, req.session_key, req.candidate_email, req.challenge_id,
             branch, req.llm_budget_usd, req.max_minutes,
             req.meet_link, req.video_platform,
             req.scheduled_at, panelists_csv),
        )
    except sqlite3.IntegrityError as e:
        if "session_key" in str(e):
            raise HTTPException(
                409, f"session_key '{req.session_key}' is already in use"
            )
        raise
    try:
        await send_invite(
            req.candidate_email, req.session_key, req.challenge_id,
            req.max_minutes, req.llm_budget_usd,
            meet_link=req.meet_link,
            scheduled_at=req.scheduled_at,
            session_id=session_id,
        )
    except Exception:
        pass
    # Panelist emails are sent separately so a SendGrid hiccup on the
    # candidate invite doesn't silently swallow the panel notifications and
    # vice versa.
    if req.panelist_emails and req.meet_link:
        for panel_email in req.panelist_emails:
            try:
                await send_panelist_invite(
                    panel_email,
                    candidate_email=req.candidate_email,
                    challenge_id=req.challenge_id,
                    max_minutes=req.max_minutes,
                    meet_link=req.meet_link,
                    scheduled_at=req.scheduled_at,
                    session_id=session_id,
                )
            except Exception:
                pass
    return {
        "session_id": session_id,
        "branch": branch,
        "meet_link": req.meet_link,
        "video_platform": req.video_platform,
        "scheduled_at": req.scheduled_at,
        "panelist_emails": req.panelist_emails,
    }


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

    repo = repo_for_challenge(session["challenge_id"])
    if not repo:
        raise HTTPException(500, "Server misconfigured: no challenge repo configured")

    if session["status"] == "pending":
        await _create_github_branch(repo, session["branch_name"])
        execute(
            "UPDATE sessions SET status='active', started_at=? WHERE id=?",
            (int(time.time()), session["id"]),
        )

    repo_url = f"https://github.com/{repo}"
    allowed_models = [m.strip() for m in settings.candidate_chat_models.split(",")]
    return ValidateSessionResponse(
        session_id=session["id"],
        repo_url=repo_url,
        branch=session["branch_name"],
        github_clone_token=settings.github_bot_pat,
        llm_proxy_url=settings.app_public_url.rstrip("/"),
        max_minutes=session["max_minutes"],
        llm_budget_usd=session["llm_budget_usd"],
        challenge_id=session["challenge_id"],
        chat_model=settings.chat_model,
        available_chat_models=allowed_models,
        meet_link=session["meet_link"],
        video_platform=session["video_platform"],
        scheduled_at=session["scheduled_at"],
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
        "cost_usd, prompt_classification, prompt_text FROM chat_exchanges "
        "WHERE session_id = ? ORDER BY ts",
        (session_id,),
    )
    focus_rows = query(
        "SELECT event_type, payload FROM telemetry "
        "WHERE session_id = ? AND event_type IN ('app_unfocused', 'app_focused') ORDER BY ts",
        (session_id,),
    )
    window_switches = sum(1 for r in focus_rows if r["event_type"] == "app_unfocused")
    suspicious_pastes = query(
        "SELECT COUNT(*) as cnt FROM telemetry "
        "WHERE session_id = ? AND event_type = 'edit_pasted' "
        "AND json_extract(payload, '$.suspicious_paste') = 1",
        (session_id,),
    )
    grading_errors = query(
        "SELECT id, ts, user_message, stage, error_class, traceback FROM grading_errors WHERE session_id = ? ORDER BY ts",
        (session_id,),
    )
    return {
        "session": rows[0],
        "grade": grades[0] if grades else None,
        "chat_exchanges": exchanges,
        "window_switches": window_switches,
        "suspicious_pastes": suspicious_pastes[0]["cnt"] if suspicious_pastes else 0,
        "grading_errors": grading_errors,
    }


async def _create_github_branch(repo: str, branch_name: str) -> None:
    headers = {
        "Authorization": f"Bearer {settings.github_bot_pat}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
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
