from typing import Any
from pydantic import BaseModel


class CreateSessionRequest(BaseModel):
    session_key: str
    candidate_email: str
    challenge_id: str
    llm_budget_usd: float = 2.00
    max_minutes: int = 90


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
