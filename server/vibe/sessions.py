import json
import logging
import os
import sqlite3
import time
import uuid
from datetime import datetime, timezone
import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
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


# Statuses a session can hold across its lifecycle. Used to validate the
# `status` filter so a typo returns an explicit 400 rather than silently
# matching nothing.
_SESSION_STATUSES = {"pending", "active", "submitted", "graded", "grading_failed"}


# Upper bound on a single page so a caller can't ask the backend to
# materialise an unbounded result set in one request.
_MAX_PAGE_SIZE = 200


@router.get("/sessions")
def list_sessions(
    x_admin_token: str = Header(None),
    org_id: str | None = None,
    search: str | None = None,
    status: list[str] | None = Query(None),
    limit: int | None = None,
    offset: int = 0,
):
    if x_admin_token != settings.admin_token:
        raise HTTPException(403, "Forbidden")
    # `org_id` is an optional tenant filter supplied by the recruiter-backend
    # proxy. When omitted (e.g. direct admin use) all sessions are returned,
    # preserving the original global behaviour.
    #
    # `search` (free-text, case-insensitive substring across candidate email,
    # session key and challenge id) and `status` (one or more lifecycle states,
    # repeatable: ?status=active&status=submitted) are optional and applied at
    # the SQL level so the client never has to page through everything.
    #
    # `limit`/`offset` paginate the (already filtered) set. `limit` omitted ⇒
    # unbounded (legacy behaviour); when given it is clamped to [1, 200]. The
    # response always carries `total` — the count of rows matching the filters
    # *before* pagination — so the client can render page controls.
    if limit is not None and limit < 1:
        raise HTTPException(400, "limit must be >= 1")
    if offset < 0:
        raise HTTPException(400, "offset must be >= 0")
    if limit is not None:
        limit = min(limit, _MAX_PAGE_SIZE)

    clauses: list[str] = []
    params: list = []
    if org_id is not None:
        clauses.append("s.org_id = ?")
        params.append(org_id)
    if search and search.strip():
        # SQLite LIKE is case-insensitive for ASCII; escape the LIKE wildcards
        # in the user term so a literal '%' or '_' doesn't widen the match.
        term = search.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        like = f"%{term}%"
        clauses.append(
            "(s.candidate_email LIKE ? ESCAPE '\\' "
            "OR s.session_key LIKE ? ESCAPE '\\' "
            "OR s.challenge_id LIKE ? ESCAPE '\\')"
        )
        params.extend([like, like, like])
    if status:
        statuses = [s.strip() for s in status if s and s.strip()]
        unknown = [s for s in statuses if s not in _SESSION_STATUSES]
        if unknown:
            raise HTTPException(
                400,
                f"Unknown status {unknown!r}; valid: {sorted(_SESSION_STATUSES)}",
            )
        if statuses:
            placeholders = ",".join("?" for _ in statuses)
            clauses.append(f"s.status IN ({placeholders})")
            params.extend(statuses)
    where = ("WHERE " + " AND ".join(clauses) + " ") if clauses else ""

    # Total of the filtered set (sessions are 1:1 with the optional grade join,
    # so counting the base table is the logical row count and avoids the join).
    total = query(f"SELECT COUNT(*) AS n FROM sessions s {where}", tuple(params))[0]["n"]

    sql = (
        "SELECT s.id, s.session_key, s.candidate_email, s.challenge_id, s.status, "
        "s.llm_spent_usd, s.llm_budget_usd, s.max_minutes, "
        "s.typed_chars, s.pasted_chars, s.ai_applied_chars, "
        "s.meet_link, s.video_platform, s.scheduled_at, s.panelist_emails, "
        "s.created_at, s.started_at, s.submitted_at, s.org_id, "
        "g.total_score "
        "FROM sessions s LEFT JOIN grades g ON g.session_id = s.id "
        f"{where}ORDER BY s.created_at DESC "
    )
    page_params = list(params)
    if limit is not None:
        sql += "LIMIT ? OFFSET ?"
        page_params.extend([limit, offset])
    elif offset:
        # SQLite needs a LIMIT to honour OFFSET; -1 means "no upper bound".
        sql += "LIMIT -1 OFFSET ?"
        page_params.append(offset)
    rows = query(sql, tuple(page_params))
    return {
        "sessions": [dict(r) for r in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


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
    # The candidate branch is cut from `source_ref` at validate-session time —
    # either the original challenge "main" or a recruiter-authored `variant/*`
    # branch. Anything outside that namespace would let a recruiter assign an
    # arbitrary ref (e.g. another candidate's `interview/*` branch), so reject it.
    source_ref = (req.source_ref or "main").strip()
    if source_ref != "main" and not source_ref.startswith("variant/"):
        raise HTTPException(400, "source_ref must be 'main' or a 'variant/...' branch")
    # Store the panel list as a CSV string in SQLite. Pydantic has already
    # normalised it to a deduplicated, lowercase list with no whitespace.
    panelists_csv = ",".join(req.panelist_emails) if req.panelist_emails else None
    try:
        execute(
            "INSERT INTO sessions "
            "(id, session_key, candidate_email, challenge_id, branch_name, "
            "llm_budget_usd, max_minutes, meet_link, video_platform, "
            "scheduled_at, panelist_emails, require_end_video, source_ref, org_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (session_id, req.session_key, req.candidate_email, req.challenge_id,
             branch, req.llm_budget_usd, req.max_minutes,
             req.meet_link, req.video_platform,
             req.scheduled_at, panelists_csv,
             1 if req.require_end_video else 0, source_ref, req.org_id),
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
        await _create_github_branch(
            repo, session["branch_name"], source_ref=session.get("source_ref") or "main"
        )
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
def get_session_detail(
    session_id: str, x_admin_token: str = Header(None), org_id: str | None = None
):
    if x_admin_token != settings.admin_token:
        raise HTTPException(403, "Forbidden")
    rows = query("SELECT * FROM sessions WHERE id = ?", (session_id,))
    if not rows:
        raise HTTPException(404, "Not found")
    # Scope to the caller's org when supplied: a session belonging to another
    # org is reported as not-found so existence isn't leaked across tenants.
    if org_id is not None and rows[0].get("org_id") != org_id:
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


async def _create_github_branch(repo: str, branch_name: str, source_ref: str = "main") -> None:
    # Mint a fresh installation token for this single branch-creation call.
    # The token lives ~1hr but we throw it away after the two HTTP calls below
    # — no caching server-side, since each session creates exactly one branch
    # and the cost of minting is one extra request to GitHub.
    #
    # `source_ref` is the branch the new branch is cut from. Defaults to "main"
    # (the original challenge); recruiter-authored `variant/*` branches let a
    # candidate be assigned an edited copy of the challenge instead.
    branch_token = await mint_installation_token(repo)
    headers = {
        "Authorization": f"Bearer {branch_token.token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"https://api.github.com/repos/{repo}/git/ref/heads/{source_ref}",
            headers=headers,
        )
        if r.status_code != 200:
            raise HTTPException(502, f"GitHub: could not get '{source_ref}' SHA: {r.text}")
        sha = r.json()["object"]["sha"]

        r = await client.post(
            f"https://api.github.com/repos/{repo}/git/refs",
            headers=headers,
            json={"ref": f"refs/heads/{branch_name}", "sha": sha},
        )
        if r.status_code not in (201, 422):  # 422 = branch already exists
            raise HTTPException(502, f"GitHub: could not create branch: {r.text}")
