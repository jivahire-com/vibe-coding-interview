import json
from fastapi import APIRouter, Depends
from vibe.auth import get_session
from vibe.db import execute, executemany
from vibe.models import TelemetryRequest

router = APIRouter(prefix="/api/v1")

_CHAR_COUNTER_EVENTS = {
    "edit_typed": "typed_chars",
    "edit_pasted": "pasted_chars",
    "edit_ai_applied": "ai_applied_chars",
}


@router.post("/telemetry", status_code=204)
def ingest_telemetry(req: TelemetryRequest, session=Depends(get_session)):
    if not req.events:
        return
    executemany(
        "INSERT INTO telemetry (session_id, ts, event_type, payload) VALUES (?, ?, ?, ?)",
        [(session["id"], e.ts, e.event_type, json.dumps(e.payload)) for e in req.events],
    )
    # Accumulate typing/paste/ai-applied char counts directly on the session row
    typed = pasted = ai_applied = 0
    for e in req.events:
        col = _CHAR_COUNTER_EVENTS.get(e.event_type)
        if col:
            chars = e.payload.get("chars", 0) or 0
            if col == "typed_chars":
                typed += chars
            elif col == "pasted_chars":
                pasted += chars
            elif col == "ai_applied_chars":
                ai_applied += chars
    if typed or pasted or ai_applied:
        execute(
            "UPDATE sessions SET typed_chars = typed_chars + ?, "
            "pasted_chars = pasted_chars + ?, "
            "ai_applied_chars = ai_applied_chars + ? WHERE id=?",
            (typed, pasted, ai_applied, session["id"]),
        )
