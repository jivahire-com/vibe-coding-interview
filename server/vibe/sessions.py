import json
import logging
import os
import sqlite3
import time
import uuid
from datetime import datetime, timezone
import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from vibe.auth import check_rate_limit, get_session
from vibe.budget import pricing_for
from vibe.config import repo_for_challenge, settings
from vibe.db import execute, query
from vibe.email import send_invite, send_panelist_invite
from vibe.github_app import mint_installation_token
from vibe.video import _feature_enabled as video_feature_enabled
from vibe.logging_config import bind_session
from vibe.models import (
    CreateSessionRequest,
    ValidateSessionRequest,
    ValidateSessionResponse,
)

router = APIRouter(prefix="/api/v1")
log = logging.getLogger("vibe.sessions")


def _resolve_require_end_video(meet_link: str | None, override: bool) -> bool:
    """Whether the candidate will be asked to record a post-submit explainer.

    Async sessions always require it when the feature is configured server-side.
    Panel sessions skip it by default — panelists verify identity live — but the
    recruiter can force it on via the per-session `require_end_video` override.
    """
    if not video_feature_enabled():
        return False
    return not meet_link or bool(override)


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
            "scheduled_at, panelist_emails, require_end_video) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (session_id, req.session_key, req.candidate_email, req.challenge_id,
             branch, req.llm_budget_usd, req.max_minutes,
             req.meet_link, req.video_platform,
             req.scheduled_at, panelists_csv,
             1 if req.require_end_video else 0),
        )
    except sqlite3.IntegrityError as e:
        if "session_key" in str(e):
            raise HTTPException(
                409, f"session_key '{req.session_key}' is already in use"
            )
        raise
    require_end_video = _resolve_require_end_video(req.meet_link, req.require_end_video)
    try:
        await send_invite(
            req.candidate_email, req.session_key, req.challenge_id,
            req.max_minutes, req.llm_budget_usd,
            meet_link=req.meet_link,
            scheduled_at=req.scheduled_at,
            session_id=session_id,
            require_end_video=require_end_video,
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
    log.info(
        "session_created",
        extra={"context": {
            "session_id": session_id,
            "challenge_id": req.challenge_id,
            "candidate_email": req.candidate_email,
            "max_minutes": req.max_minutes,
            "llm_budget_usd": req.llm_budget_usd,
            "panelists": len(req.panelist_emails or []),
        }},
    )
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
        log.warning("validate_session_not_found", extra={"context": {"ip": ip}})
        raise HTTPException(404, "Session not found")

    session = rows[0]
    bind_session(session["id"])
    if session["status"] not in ("pending", "active"):
        log.warning(
            "validate_session_wrong_status",
            extra={"context": {"status": session["status"]}},
        )
        raise HTTPException(409, f"Session is {session['status']}")

    # Block early-start for scheduled panel interviews. A panel session has
    # either a meet_link or panelist_emails attached; if it also carries a
    # future scheduled_at, refuse to clone/branch/start the timer ahead of
    # time — the interviewers won't be on the call yet, and starting early
    # would mean the candidate's countdown begins before they're supposed to.
    scheduled_at = session["scheduled_at"]
    is_panel = bool(session["meet_link"]) or bool(session["panelist_emails"])
    if is_panel and scheduled_at and scheduled_at > int(time.time()):
        human_utc = datetime.fromtimestamp(scheduled_at, tz=timezone.utc).strftime(
            "%a %b %d, %Y %H:%M UTC"
        )
        log.info(
            "validate_session_too_early",
            extra={"context": {"scheduled_at": scheduled_at}},
        )
        raise HTTPException(
            403,
            detail={
                "code": "session_not_yet_open",
                "scheduled_at": scheduled_at,
                "message": (
                    f"This panel interview is scheduled for {human_utc}. "
                    f"Please wait until the scheduled time to start — your "
                    f"interviewer will join the video call then."
                ),
            },
        )

    repo = repo_for_challenge(session["challenge_id"])
    if not repo:
        log.error("validate_session_misconfigured", extra={"context": {"challenge_id": session["challenge_id"]}})
        raise HTTPException(500, "Server misconfigured: no challenge repo configured")

    if session["status"] == "pending":
        await _create_github_branch(repo, session["branch_name"])
        execute(
            "UPDATE sessions SET status='active', started_at=? WHERE id=?",
            (int(time.time()), session["id"]),
        )
        log.info("session_activated", extra={"context": {"challenge_id": session["challenge_id"]}})

    # Mint a repo-scoped, ~1hr installation token for the candidate. This
    # replaces the long-lived github_bot_pat that used to be shipped here —
    # see server/vibe/github_app.py for why that matters. The extension
    # refreshes the token periodically via POST /api/v1/refresh-github-token.
    try:
        clone_token = await mint_installation_token(repo)
    except Exception as e:
        log.error("validate_session_mint_failed", extra={"context": {"err": str(e)}})
        raise HTTPException(502, "Could not mint GitHub clone token")

    repo_url = f"https://github.com/{repo}"
    allowed_models = [m.strip() for m in settings.candidate_chat_models.split(",")]
    pricing = {m: pricing_for(m) for m in allowed_models}
    return ValidateSessionResponse(
        session_id=session["id"],
        repo_url=repo_url,
        branch=session["branch_name"],
        github_clone_token=clone_token.token,
        github_clone_token_expires_at=clone_token.expires_at,
        llm_proxy_url=settings.app_public_url.rstrip("/"),
        max_minutes=session["max_minutes"],
        llm_budget_usd=session["llm_budget_usd"],
        challenge_id=session["challenge_id"],
        chat_model=settings.chat_model,
        available_chat_models=allowed_models,
        pricing_per_million=pricing,
        meet_link=session["meet_link"],
        video_platform=session["video_platform"],
        scheduled_at=session["scheduled_at"],
        require_end_video=_resolve_require_end_video(
            session["meet_link"], bool(session.get("require_end_video") or 0)
        ),
    )


@router.post("/refresh-github-token")
async def refresh_github_token(session: dict = Depends(get_session)):
    """Mint a fresh repo-scoped installation token for an active session.

    Called by the extension shortly before the previous token expires (GitHub
    caps installation tokens at ~1 hour, and our max_minutes is often longer).
    Refusing for submitted/expired sessions matters: a candidate who has
    already submitted shouldn't be able to keep cycling tokens to push to
    their old branch.
    """
    if session["status"] != "active":
        # 409 — same shape as the validate-session "wrong status" path so the
        # extension can treat both consistently.
        raise HTTPException(409, f"Session is {session['status']}")
    repo = repo_for_challenge(session["challenge_id"])
    if not repo:
        raise HTTPException(500, "Server misconfigured: no challenge repo configured")
    try:
        token = await mint_installation_token(repo)
    except Exception as e:
        log.error("refresh_token_mint_failed", extra={"context": {"err": str(e)}})
        raise HTTPException(502, "Could not mint GitHub clone token")
    return {
        "github_clone_token": token.token,
        "github_clone_token_expires_at": token.expires_at,
    }


@router.get("/sessions/{session_id}")
def get_session_detail(session_id: str, x_admin_token: str = Header(None)):
    if x_admin_token != settings.admin_token:
        raise HTTPException(403, "Forbidden")
    rows = query("SELECT * FROM sessions WHERE id = ?", (session_id,))
    if not rows:
        raise HTTPException(404, "Not found")
    grades = query("SELECT * FROM grades WHERE session_id = ?", (session_id,))
    exchanges = query(
        "SELECT ts, prompt_tokens, completion_tokens, candidate_prompt_tokens, "
        "cached_input_tokens, reasoning_tokens, "
        "cost_usd, prompt_classification, prompt_score, prompt_reasoning, prompt_text "
        "FROM chat_exchanges WHERE session_id = ? ORDER BY ts",
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
    # protected_file_edit rows are already deduped per-file by the extension,
    # so each row is a distinct tampered file. `source` is "editor" (typed in
    # VS Code) or "external" (e.g. terminal/shell), useful for triage.
    tamper_rows = query(
        "SELECT payload FROM telemetry "
        "WHERE session_id = ? AND event_type = 'protected_file_edit' ORDER BY ts",
        (session_id,),
    )
    protected_file_edits = [json.loads(r["payload"]) for r in tamper_rows]
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
        "protected_file_edits": protected_file_edits,
        "grading_errors": grading_errors,
    }


async def _create_github_branch(repo: str, branch_name: str) -> None:
    # Mint a fresh installation token for this single branch-creation call.
    # The token lives ~1hr but we throw it away after the two HTTP calls below
    # — no caching server-side, since each session creates exactly one branch
    # and the cost of minting is one extra request to GitHub.
    branch_token = await mint_installation_token(repo)
    headers = {
        "Authorization": f"Bearer {branch_token.token}",
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
