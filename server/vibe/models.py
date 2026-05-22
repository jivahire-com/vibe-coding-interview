from typing import Any
from pydantic import BaseModel, field_validator


_ALLOWED_VIDEO_PLATFORMS = {"google_meet", "zoom", "teams", "other"}


class CreateSessionRequest(BaseModel):
    session_key: str
    candidate_email: str
    challenge_id: str
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


class TelemetryEvent(BaseModel):
    ts: int
    event_type: str
    payload: dict[str, Any]


class TelemetryRequest(BaseModel):
    events: list[TelemetryEvent]


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    model: str | None = None
