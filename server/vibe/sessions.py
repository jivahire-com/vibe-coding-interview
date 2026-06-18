import json
import logging
import os
import sqlite3
import time
import uuid
from datetime import datetime, timezone
from typing import Any
import httpx
from pydantic import BaseModel
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from vibe.auth import check_rate_limit, get_session
from vibe.budget import pricing_for
from vibe.config import repo_for_challenge, settings
from vibe.db import execute, query
from vibe.email import send_invite, send_panelist_invite
from vibe.github_app import mint_installation_token
from vibe.video import STATIC_PROMPTS, _feature_enabled as video_feature_enabled
from vibe.logging_config import bind_session
from vibe.models import (
    CreateSessionRequest,
    Dependency,
    SessionPreflightRequest,
    SessionPreflightResponse,
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


def load_challenge_metadata(challenge_id: str) -> dict:
    """Read a challenge's `.jivahire/metadata.json` off the local filesystem.

    Returns an empty dict if the file is missing or unparsable — callers default
    individual fields. Mirrors the inline reads in list_challenges/create_session.
    """
    meta_path = os.path.join(
        settings.challenges_dir, challenge_id, ".jivahire", "metadata.json"
    )
    try:
        with open(meta_path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def load_challenge_tests_traps(challenge_id: str) -> dict:
    """Short, recruiter-facing descriptions of a challenge's hidden-test groups
    and planted traps, read off the challenge's `.jivahire/` config.

    `tests` comes from rubric.json `tasks` (one entry per hidden-test tag);
    `traps` from traps.json. Each is `{id, description}` with a short string
    suitable for a list view — never the underlying test code. Tests prefer the
    optional `tasks[].description`, falling back to a humanised id; traps prefer
    the optional short `summary`, falling back to the full `description`. Missing
    or unparsable files yield empty lists so the caller can render nothing.
    """
    base = os.path.join(settings.challenges_dir, challenge_id, ".jivahire")

    def _read(name: str) -> dict:
        try:
            with open(os.path.join(base, name), "r", encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return {}

    tests = []
    for task in _read("rubric.json").get("tasks", []):
        tid = task.get("id")
        if not tid:
            continue
        desc = task.get("description") or tid.replace("_", " ").capitalize()
        tests.append({"id": tid, "description": desc})

    traps = []
    for trap in _read("traps.json").get("traps", []):
        tid = trap.get("id")
        if not tid:
            continue
        desc = trap.get("summary") or trap.get("description") or ""
        traps.append({"id": tid, "description": desc})

    return {"tests": tests, "traps": traps}


def _normalize_dependencies(raw) -> tuple[list[Dependency], list[str]]:
    """Build the preflight dependency list from a challenge's `dependencies`.

    Accepts two metadata shapes:
      * nested — ``{"toolchain": [{name, min_version, check, install}],
        "auto_fetched": [...]}`` (used by cpp-thread-safe-cache)
      * legacy flat — ``[{"label", "check"}, ...]`` (still used by the other
        challenges; ``label`` maps to ``name``)
    Malformed entries are dropped silently — preflight is advisory, not a gate.
    """
    if isinstance(raw, dict):
        toolchain = raw.get("toolchain") or []
        auto_fetched = [s for s in (raw.get("auto_fetched") or []) if isinstance(s, str)]
    elif isinstance(raw, list):
        toolchain, auto_fetched = raw, []
    else:
        return [], []

    deps: list[Dependency] = []
    for d in toolchain:
        if not isinstance(d, dict):
            continue
        name = d.get("name") or d.get("label")
        check = d.get("check")
        if not (isinstance(name, str) and name and isinstance(check, str) and check):
            continue
        min_version = d.get("min_version")
        install = d.get("install")
        deps.append(
            Dependency(
                name=name,
                min_version=min_version if isinstance(min_version, str) else None,
                check=check,
                install={k: v for k, v in install.items() if isinstance(v, str)}
                if isinstance(install, dict)
                else {},
            )
        )
    return deps, auto_fetched


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
        "s.ai_assistance, "
        "s.created_at, s.started_at, s.submitted_at, s.org_id, s.recruiter_email, "
        "s.invalidated_at, s.invalidation_reason, "
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
    sessions = []
    for r in rows:
        d = dict(r)
        # `total_score` is stored as REAL (e.g. 76.0). Surface it as an int on the
        # 0-100 scale so the list matches the detail API's report.overall.score
        # (which is a rounded int out of 100), rather than a bare float.
        if d.get("total_score") is not None:
            d["total_score"] = int(round(d["total_score"]))
        # `ai_assisted`: the invite-time AI-assistance toggle set by the recruiter
        # (sessions.ai_assistance, default enabled), not whether AI was actually used.
        d["ai_assisted"] = bool(d.get("ai_assistance", 1))
        # `is_panel`: a panel interview carries a meet link or panelist emails —
        # same definition the start/validate path uses (see is_panel in validate-session).
        d["is_panel"] = bool(d.get("meet_link")) or bool(d.get("panelist_emails"))
        sessions.append(d)
    return {
        "sessions": sessions,
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

    # Only cpp-thread-safe-cache is offered to recruiters right now. Other
    # challenge dirs remain on disk (grading/existing sessions still need them)
    # but are filtered out of this listing.
    entries = [d for d in entries if d == "cpp-thread-safe-cache"]

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
            "scheduled_at, panelist_emails, require_end_video, ai_assistance, "
            "source_ref, org_id, recruiter_email) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (session_id, req.session_key, req.candidate_email, req.challenge_id,
             branch, req.llm_budget_usd, req.max_minutes,
             req.meet_link, req.video_platform,
             req.scheduled_at, panelists_csv,
             1 if req.require_end_video else 0,
             1 if req.ai_assistance else 0, source_ref, req.org_id,
             req.recruiter_email),
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
            ai_assistance=req.ai_assistance,
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


@router.post("/session-preflight", response_model=SessionPreflightResponse)
async def session_preflight(req: SessionPreflightRequest, request: Request):
    """Read-only challenge info for the extension's pre-clone dialog.

    Returns the assigned challenge's language and tooling dependencies so the
    candidate can verify (and install) the required toolchain BEFORE the session
    is activated. Unlike validate-session, this does NOT create the candidate
    branch, mint a token, or start the timer — the session stays untouched.
    """
    ip = request.client.host
    # Rate-limit before the session-key DB lookup (same invariant as
    # validate-session). An invalid key stops here, so the brute-force path
    # still costs exactly one attempt per try.
    check_rate_limit(ip)

    rows = query("SELECT * FROM sessions WHERE session_key = ?", (req.session_key,))
    if not rows:
        log.warning("session_preflight_not_found", extra={"context": {"ip": ip}})
        raise HTTPException(404, "Session not found")

    session = rows[0]
    bind_session(session["id"])
    if session["status"] not in ("pending", "active"):
        raise HTTPException(409, f"Session is {session['status']}")

    meta = load_challenge_metadata(session["challenge_id"])
    deps, auto_fetched = _normalize_dependencies(meta.get("dependencies"))
    return SessionPreflightResponse(
        challenge_id=session["challenge_id"],
        title=meta.get("title") or session["challenge_id"],
        language=meta.get("language") or "unknown",
        dependencies=deps,
        auto_fetched=auto_fetched,
    )


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
            repo, session["branch_name"],
            source_ref=session.get("source_ref") or "main",
            session_id=session["id"],
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
        ai_assistance=bool(session.get("ai_assistance", 1)),
        language=load_challenge_metadata(session["challenge_id"]).get("language") or "unknown",
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


class InvalidateRequest(BaseModel):
    reason: str = "Interview integrity violation"


@router.post("/invalidate")
def invalidate_session(req: InvalidateRequest, session: dict = Depends(get_session)):
    """Flag an active session as integrity-violated WITHOUT ending it.

    Called by the extension when the candidate deletes the `.jivahire/`
    integrity marker. The candidate keeps working — the session stays
    `active`, so the timer, AI chat, auto-commit, submit and grading all
    continue as normal — but `invalidated_at`/`invalidation_reason` are
    stamped so the recruiter dashboard can surface the tamper. Idempotent:
    the first flag wins (its reason/timestamp are preserved on re-deletion);
    submitted/graded sessions are left untouched.
    """
    if session["status"] != "active":
        return {"status": session["status"], "message": "Session is not active."}
    if session.get("invalidated_at"):
        return {
            "status": session["status"],
            "invalidated_at": session["invalidated_at"],
            "invalidation_reason": session.get("invalidation_reason"),
            "message": "Session already flagged as invalid.",
        }
    reason = (req.reason or "").strip()[:500] or "Interview integrity violation"
    execute(
        "UPDATE sessions SET invalidated_at=?, invalidation_reason=? WHERE id=?",
        (int(time.time()), reason, session["id"]),
    )
    log.warning(
        "session_invalidated",
        extra={"context": {"challenge_id": session.get("challenge_id"), "reason": reason}},
    )
    return {
        "status": session["status"],
        "invalidated": True,
        "invalidation_reason": reason,
        "message": "Session flagged as invalid; candidate may continue.",
    }


def _parse_report(grade: dict[str, Any] | None) -> dict[str, Any] | None:
    """The grade's structured report (GRADING_METRICS_MAP.md §5), parsed from
    `report_json`. Returns None for a legacy row that predates the three-layer
    rework (no `report_json`), so the API can fall back gracefully."""
    if not grade:
        return None
    raw = grade.get("report_json")
    if not raw:
        return None
    try:
        return json.loads(raw) if isinstance(raw, str) else raw
    except (ValueError, TypeError):
        return None


def _file_time_breakdown(session_id: str) -> list[dict[str, Any]]:
    """Per-file wall-clock the candidate spent with each file focused.

    Mirrors the grader's `files_explored_detail` (signals._file_time_detail) so
    the dashboard sees the same numbers before a session is graded: every file
    that was ever opened appears (0 ms if it was opened but never focused), and
    `file_focus {file, ms}` durations are summed per file. Sorted by time desc,
    then path, so the busiest file leads.
    """
    rows = query(
        "SELECT event_type, payload FROM telemetry "
        "WHERE session_id = ? AND event_type IN ('file_open', 'file_focus')",
        (session_id,),
    )
    file_time_ms: dict[str, int] = {}
    for r in rows:
        try:
            payload = json.loads(r["payload"])
        except (ValueError, TypeError):
            continue
        f = payload.get("file")
        if not f:
            continue
        if r["event_type"] == "file_open":
            file_time_ms.setdefault(f, 0)
            continue
        ms = payload.get("ms")
        if not isinstance(ms, (int, float)) or ms <= 0:
            continue
        file_time_ms[f] = file_time_ms.get(f, 0) + int(ms)
    return [
        {"file": f, "ms": ms}
        for f, ms in sorted(file_time_ms.items(), key=lambda kv: (-kv[1], kv[0]))
    ]


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
    grade = grades[0] if grades else None
    report = _parse_report(grade)
    # The candidate-prompt rows still travel separately (the report's telemetry
    # catalogue summarises them, but the recruiter "Candidate Prompts" card needs
    # the per-prompt text + classification badges).
    exchanges = query(
        "SELECT ts, prompt_tokens, completion_tokens, candidate_prompt_tokens, "
        "cached_input_tokens, reasoning_tokens, "
        "cost_usd, prompt_classification, prompt_score, prompt_reasoning, prompt_text "
        "FROM chat_exchanges WHERE session_id = ? ORDER BY ts",
        (session_id,),
    )
    grading_errors = query(
        "SELECT id, ts, user_message, stage, error_class, traceback FROM grading_errors WHERE session_id = ? ORDER BY ts",
        (session_id,),
    )
    # The prompts the candidate was asked to address in the post-submit explainer
    # video — the same list video_init/browser_init hand the recording page. Only
    # populated when an end video was required for this session (panel sessions
    # without an override skip it, so no questions were asked); empty otherwise so
    # the recruiter card can render "none asked" without inferring the gate itself.
    end_of_interview_questions = (
        list(STATIC_PROMPTS)
        if _resolve_require_end_video(
            rows[0].get("meet_link"), bool(rows[0].get("require_end_video") or 0)
        )
        else []
    )
    # Code-free descriptions of what this challenge checks: the hidden-test
    # groups and the planted traps, each {id, description}. Driven by the
    # challenge config (not the candidate's run), so present regardless of grade
    # status. The actual test SOURCE is deliberately NOT returned here — it is
    # fetched on demand from GET /api/v1/challenges/{cid}/tests/code (see
    # challenge_tests.py) so a session poll never carries the heavy test files.
    tests_traps = load_challenge_tests_traps(rows[0]["challenge_id"])
    return {
        "session": rows[0],
        # The single structured report — score + summary, every rubric with its
        # Good/Bad yardstick and strong/weak/missing subpoints, bonuses, and the
        # telemetry catalogue. Definitions ship inside it; the page does no math.
        # None for a legacy row graded before the three-layer rework.
        "report": report,
        # Flat grade row (track / total_score / band / graded_at, plus any legacy
        # columns) for dashboards that only need the headline number.
        "grade": grade,
        # The hidden-test groups and planted traps this challenge checks, each a
        # short {id, description} string — code-free, for a list view alongside
        # the grade's tests_passed/traps_detected counts. The test source is a
        # separate fetch (GET /api/v1/challenges/{cid}/tests/code).
        "challenge_tests": tests_traps["tests"],
        "challenge_traps": tests_traps["traps"],
        "chat_exchanges": exchanges,
        "grading_errors": grading_errors,
        # Per-file time-on-file [{file, ms}, …] derived live from telemetry
        # file_open/file_focus events — available even before grading. Same
        # shape and ordering as the report's files_explored_detail.
        "file_time": _file_time_breakdown(session_id),
        # The end-of-interview explainer-video prompts the candidate was asked
        # to address (empty when no end video was required for this session).
        "end_of_interview_questions": end_of_interview_questions,
    }


async def _create_github_branch(
    repo: str, branch_name: str, source_ref: str = "main", session_id: str = "",
    provision: bool = True,
) -> None:
    # Mint a fresh installation token for this single branch-creation call.
    # The token lives ~1hr but we throw it away after the HTTP calls below
    # — no caching server-side, since each session creates exactly one branch
    # and the cost of minting is one extra request to GitHub.
    #
    # `source_ref` is the branch the new branch is cut from. Defaults to "main"
    # (the original challenge); recruiter-authored `variant/*` branches let a
    # candidate be assigned an edited copy of the challenge instead.
    #
    # `provision` controls the post-create commit. Candidate `interview/*`
    # branches set it True: the `.jivahire/` answer key is stripped and the
    # telemetry integrity marker planted. Recruiter `variant/*` branches set it
    # False: the variant is a faithful copy of `source_ref` that KEEPS the
    # `.jivahire/` files (incl. metadata.json) so they're carried into the
    # candidate branch later cut from it. Those files stay read-only — the
    # recruiter editor blocks reads/writes under `.jivahire/` (see repo_files).
    branch_token = await mint_installation_token(repo)
    headers = {
        "Authorization": f"Bearer {branch_token.token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    base = f"https://api.github.com/repos/{repo}"
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"{base}/git/ref/heads/{source_ref}", headers=headers
        )
        if r.status_code != 200:
            raise HTTPException(502, f"GitHub: could not get '{source_ref}' SHA: {r.text}")
        sha = r.json()["object"]["sha"]

        r = await client.post(
            f"{base}/git/refs",
            headers=headers,
            json={"ref": f"refs/heads/{branch_name}", "sha": sha},
        )
        if r.status_code == 422:  # branch already exists — already provisioned
            return
        if r.status_code != 201:
            raise HTTPException(502, f"GitHub: could not create branch: {r.text}")

        if not provision:
            # Variant branch: leave it as an exact copy of `source_ref`, keeping
            # the `.jivahire/` files intact. No strip, no integrity marker — a
            # candidate is never handed a variant directly; the interview branch
            # cut from it at validate time is what gets provisioned.
            return

        # Provision the freshly-cut candidate branch with a single commit that:
        #   (1) strips the `.jivahire/` answer key (rubric, traps) so it can
        #       never reach the candidate's clone — fail closed — while keeping
        #       `.jivahire/metadata.json` (candidate-safe requirements); and
        #   (2) plants the `.jivahire/telemetry.jsonl` integrity marker the
        #       extension watches for tamper detection.
        # This is the enforcement point for the CLAUDE.md rule that the
        # `.jivahire/` answer key must be stripped before the candidate branch
        # is usable.
        await _provision_candidate_branch(client, base, headers, branch_name, sha, session_id)


# A single JSONL line. The candidate sees a plausible "telemetry" file; the
# extension watches it and, if it's deleted, flags the session as invalid
# (with a stored reason for the recruiter) while letting the candidate continue.
def _integrity_marker(session_id: str) -> str:
    return json.dumps({
        "type": "session_init",
        "session_id": session_id,
        "notice": (
            "JivaHire interview integrity marker. Do NOT delete this file or the "
            ".jivahire/ directory — deleting it will invalidate your interview session."
        ),
    }) + "\n"


async def _provision_candidate_branch(client, base, headers, branch_name, sha, session_id):
    # Resolve the branch's tree, then build a new tree that strips the answer
    # key (rubric, traps, and any other `.jivahire/` files) while KEEPING
    # `.jivahire/metadata.json` so the extension can read the challenge
    # requirements from the candidate's own clone. `telemetry.jsonl` is replaced
    # with our integrity marker. Any failure here is fatal: a branch that might
    # still carry the answer key must not be handed to a candidate.
    rc = await client.get(f"{base}/git/commits/{sha}", headers=headers)
    if rc.status_code != 200:
        raise HTTPException(502, f"GitHub: could not read base commit: {rc.text}")
    tree_sha = rc.json()["tree"]["sha"]

    rt = await client.get(
        f"{base}/git/trees/{tree_sha}", headers=headers, params={"recursive": "1"}
    )
    if rt.status_code != 200:
        raise HTTPException(502, f"GitHub: could not read base tree: {rt.text}")

    # `metadata.json` is candidate-safe (requirements/language only) and is kept.
    # `telemetry.jsonl` is left to the explicit append below so we never emit two
    # tree entries for the same path.
    keep = {".jivahire/metadata.json", ".jivahire/telemetry.jsonl"}
    new_tree: list[dict] = []
    for entry in rt.json().get("tree", []):
        path = entry["path"]
        if entry.get("type") == "blob" and path.startswith(".jivahire/") and path not in keep:
            # sha=None deletes the path in a tree built on `base_tree`.
            new_tree.append({
                "path": path, "mode": entry["mode"],
                "type": "blob", "sha": None,
            })
    new_tree.append({
        "path": ".jivahire/telemetry.jsonl", "mode": "100644",
        "type": "blob", "content": _integrity_marker(session_id),
    })

    ct = await client.post(
        f"{base}/git/trees", headers=headers,
        json={"base_tree": tree_sha, "tree": new_tree},
    )
    if ct.status_code != 201:
        raise HTTPException(502, f"GitHub: could not create candidate tree: {ct.text}")

    cc = await client.post(
        f"{base}/git/commits", headers=headers,
        json={
            "message": "chore: provision candidate workspace (strip answer key, add integrity marker)",
            "tree": ct.json()["sha"], "parents": [sha],
        },
    )
    if cc.status_code != 201:
        raise HTTPException(502, f"GitHub: could not create candidate commit: {cc.text}")

    rp = await client.patch(
        f"{base}/git/refs/heads/{branch_name}", headers=headers,
        json={"sha": cc.json()["sha"], "force": True},
    )
    if rp.status_code != 200:
        raise HTTPException(502, f"GitHub: could not update candidate branch: {rp.text}")
