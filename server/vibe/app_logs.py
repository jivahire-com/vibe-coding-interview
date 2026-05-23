"""Client log ingest + admin retrieval.

The extension buffers structured log records locally and POSTs them here in
batches (mirrors the telemetry buffer pattern). Records land in `app_logs`
alongside the JSON formatter's server/worker output on disk, so a recruiter
can audit both sides through the same query endpoint.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, field_validator

from vibe.auth import get_session
from vibe.config import settings
from vibe.db import executemany, query

router = APIRouter(prefix="/api/v1")
log = logging.getLogger("vibe.app_logs")

_ALLOWED_LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
_ALLOWED_SOURCES_FOR_QUERY = {"extension", "server", "worker", "grader"}
_MAX_MESSAGE_LEN = 8 * 1024  # bytes — anything bigger is almost certainly a bug, not a log


class LogRecord(BaseModel):
    ts: int
    level: str
    message: str
    logger: str | None = None
    context: dict[str, Any] | None = None

    @field_validator("level")
    @classmethod
    def _level_upper(cls, v: str) -> str:
        up = v.upper()
        if up not in _ALLOWED_LEVELS:
            raise ValueError(f"level must be one of {sorted(_ALLOWED_LEVELS)}")
        return up

    @field_validator("message")
    @classmethod
    def _trim_message(cls, v: str) -> str:
        if len(v) > _MAX_MESSAGE_LEN:
            return v[:_MAX_MESSAGE_LEN] + "…[truncated]"
        return v


class LogsRequest(BaseModel):
    records: list[LogRecord]


@router.post("/logs", status_code=204)
def ingest_logs(req: LogsRequest, session=Depends(get_session)) -> None:
    if not req.records:
        return
    rows = [
        (
            r.ts,
            "extension",
            r.level,
            r.logger,
            r.message,
            session["id"],
            json.dumps(r.context) if r.context else None,
        )
        for r in req.records
    ]
    executemany(
        "INSERT INTO app_logs (ts, source, level, logger, message, session_id, context) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        rows,
    )
    # Mirror errors from the client into the server's own log stream so a
    # single `tail -f logs/server.log | jq 'select(.level=="ERROR")'` surfaces
    # both sides of a failing flow.
    for r in req.records:
        if r.level in ("ERROR", "CRITICAL"):
            log.error(
                f"client: {r.message}",
                extra={"context": {"source": "extension", "session_id": session["id"], **(r.context or {})}},
            )


def _admin(authorization: str = Header(None)) -> None:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing Bearer token")
    if authorization[7:] != settings.admin_token:
        raise HTTPException(401, "Invalid admin token")


@router.get("/logs")
def list_logs(
    _: None = Depends(_admin),
    level: str | None = None,
    source: str | None = None,
    session_id: str | None = None,
    since: int | None = None,
    limit: int = 200,
) -> list[dict]:
    """Browse client logs (`app_logs` table) without dropping into sqlite3."""
    limit = max(1, min(limit, 1000))
    where: list[str] = []
    params: list[Any] = []
    if level:
        up = level.upper()
        if up not in _ALLOWED_LEVELS:
            raise HTTPException(400, f"level must be one of {sorted(_ALLOWED_LEVELS)}")
        where.append("level = ?")
        params.append(up)
    if source:
        if source not in _ALLOWED_SOURCES_FOR_QUERY:
            raise HTTPException(400, f"source must be one of {sorted(_ALLOWED_SOURCES_FOR_QUERY)}")
        where.append("source = ?")
        params.append(source)
    if session_id:
        where.append("session_id = ?")
        params.append(session_id)
    if since is not None:
        where.append("ts >= ?")
        params.append(since)
    sql = "SELECT id, ts, source, level, logger, message, session_id, context FROM app_logs"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY ts DESC LIMIT ?"
    params.append(limit)
    rows = query(sql, tuple(params))
    for r in rows:
        if r.get("context"):
            try:
                r["context"] = json.loads(r["context"])
            except Exception:
                pass  # leave as raw string if it isn't parseable JSON
    return rows
