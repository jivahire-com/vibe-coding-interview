from typing import Any
from pydantic import BaseModel, field_validator


_ALLOWED_VIDEO_PLATFORMS = {"google_meet", "zoom", "teams", "other"}


class CreateSessionRequest(BaseModel):
    session_key: str
    candidate_email: str
    challenge_id: str
    # Git ref the candidate's interview branch is cut from. "main" is the
    # original challenge; a "variant/..." branch is a recruiter-edited copy
    # (see repo_files.py). Validated against the variant namespace server-side.
    source_ref: str = "main"
    llm_budget_usd: float = 2.00
    max_minutes: int = 90
    meet_link: str | None = None
    video_platform: str = "google_meet"
    # Epoch seconds (UTC). When set, the invite includes a `.ics` calendar
    # attachment so the candidate and panelists get a native calendar entry.
    scheduled_at: int | None = None
    # Optional panel-interviewer emails. Each receives a separate invite that
    # contains the meeting link + scheduled time, but NOT the session key.
    panelist_emails: list[str] = []
    # Override the panel-session default of "skip post-submit explainer video".
    # Async sessions always require the end-video when the feature is enabled;
    # this flag only matters for panel sessions, where panelists normally
    # verify identity live. When True, the candidate is asked to record an
    # explainer after submitting even if a meet link is set.
    require_end_video: bool = False
    # Whether the candidate has the AI chat assistant during the interview.
    # True (default) is the original "vibe coding" experience: AI chat + LLM
    # proxy + AI-usage grading. False is a "normal coding" interview — no AI
    # chat in the editor, the LLM proxy refuses chat, and the AI-interaction
    # grading dimensions are dropped (see grader/runner.py). Orthogonal to
    # panel vs async: a normal interview can still be a panel or async session.
    ai_assistance: bool = True
    # Organization tag set by the recruiter-backend proxy. Used only to scope
    # admin list/detail queries to a single org; never surfaced to candidates.
    org_id: str | None = None
    # Email of the recruiter who sent the invite, set by the recruiter-backend
    # proxy. Surfaced in admin list/detail so the dashboard can show who
    # invited the candidate; never surfaced to candidates.
    recruiter_email: str | None = None

    @field_validator("meet_link")
    @classmethod
    def _validate_meet_link(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not v:
            return None
        if not v.startswith("https://"):
            raise ValueError("meet_link must start with https://")
        return v

    @field_validator("video_platform")
    @classmethod
    def _validate_platform(cls, v: str) -> str:
        if v not in _ALLOWED_VIDEO_PLATFORMS:
            raise ValueError(
                f"video_platform must be one of {sorted(_ALLOWED_VIDEO_PLATFORMS)}"
            )
        return v

    @field_validator("panelist_emails", mode="before")
    @classmethod
    def _normalise_panelists(cls, v: object) -> list[str]:
        if v is None or v == "":
            return []
        # Accept either a list or a comma-separated string so the dashboard
        # form can post a raw textarea value without splitting client-side.
        items: list[str]
        if isinstance(v, str):
            items = [s for s in (chunk.strip() for chunk in v.split(",")) if s]
        elif isinstance(v, list):
            items = [str(s).strip() for s in v if str(s).strip()]
        else:
            raise ValueError("panelist_emails must be a list of strings or a comma-separated string")
        cleaned: list[str] = []
        seen: set[str] = set()
        for email in items:
            low = email.lower()
            if "@" not in low or " " in low:
                raise ValueError(f"invalid panelist email: {email!r}")
            if low in seen:
                continue
            seen.add(low)
            cleaned.append(low)
        return cleaned

    @field_validator("scheduled_at")
    @classmethod
    def _validate_scheduled_at(cls, v: int | None) -> int | None:
        if v is None:
            return None
        # Sanity: must look like an epoch second, not millis. Reject anything
        # absurdly far in the past so a JS-milliseconds slip-up is caught.
        # 2010-01-01 = 1_262_304_000; 2100-01-01 = 4_102_444_800.
        if not (1_262_304_000 <= v <= 4_102_444_800):
            raise ValueError(
                "scheduled_at must be epoch seconds between 2010 and 2100"
            )
        return v


class ValidateSessionRequest(BaseModel):
    session_key: str


class ValidateSessionResponse(BaseModel):
    session_id: str
    repo_url: str
    branch: str
    github_clone_token: str
    # Unix epoch seconds (UTC) at which github_clone_token stops being accepted
    # by GitHub. The extension uses this to schedule a refresh before expiry;
    # without it, sessions longer than ~1 hour would silently break on the
    # next auto-commit push.
    github_clone_token_expires_at: int
    llm_proxy_url: str
    max_minutes: int
    llm_budget_usd: float
    challenge_id: str
    chat_model: str
    available_chat_models: list[str]
    # Per-million-token pricing for each model in `available_chat_models`, keyed
    # by model id. The extension uses this to keep its local spend meter in sync
    # with the server's budget enforcement when new / expensive models are
    # introduced.
    pricing_per_million: dict[str, dict[str, float]] = {}
    meet_link: str | None = None
    video_platform: str | None = None
    scheduled_at: int | None = None
    # True iff the candidate must record a short solution-explainer video after
    # submitting. Resolved server-side from the feature flag + per-session
    # override so the extension can surface an upfront notice in the dashboard.
    require_end_video: bool = False
    # Whether this session grants the AI chat assistant. False ⇒ "normal coding"
    # interview: the extension hides/disables the AI chat and the LLM proxy
    # refuses chat. Defaults True so older servers/extensions keep AI on.
    ai_assistance: bool = True
    # Coding language of the assigned challenge (from .jivahire/metadata.json).
    # Lets the extension show a language badge on the session brief after a
    # workspace reopen, when the pre-clone preflight is no longer in play.
    language: str = "unknown"


class Dependency(BaseModel):
    # Human-readable tool name shown to the candidate (e.g. "CMake").
    name: str
    # Minimum acceptable version, free-form (e.g. "3.14" or "GCC 11+, Clang 14+").
    # Display-only — the extension shows it but does not parse or enforce it.
    min_version: str | None = None
    # A `<tool> <flag>` command the extension runs to verify the tool is
    # installed (e.g. "cmake --version"). Executed without a shell on the
    # candidate's machine — see runDependencyChecks in the extension.
    check: str
    # Per-OS install hints keyed by platform ("macos", "debian", "windows"),
    # surfaced when the check fails. Optional.
    install: dict[str, str] = {}


class SessionPreflightRequest(BaseModel):
    session_key: str


class SessionPreflightResponse(BaseModel):
    # Read-only challenge info shown in the pre-clone confirmation dialog. This
    # response does NOT activate the session or start the timer — that happens
    # only when the candidate confirms and the extension calls validate-session.
    challenge_id: str
    title: str
    language: str = "unknown"
    dependencies: list[Dependency] = []
    # Tooling fetched automatically by the build (e.g. "Catch2 v3 — fetched by
    # CMake on first build"). Informational; no install check is run for these.
    auto_fetched: list[str] = []


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    model: str | None = None
