import json
from fastapi import APIRouter, Depends
from vibe.auth import get_session
from vibe.db import executemany
from vibe.models import TelemetryRequest

router = APIRouter(prefix="/api/v1")


@router.post("/telemetry", status_code=204)
def ingest_telemetry(req: TelemetryRequest, session=Depends(get_session)):
    if not req.events:
        return
    executemany(
        "INSERT INTO telemetry (session_id, ts, event_type, payload) VALUES (?, ?, ?, ?)",
        [(session["id"], e.ts, e.event_type, json.dumps(e.payload)) for e in req.events],
    )
