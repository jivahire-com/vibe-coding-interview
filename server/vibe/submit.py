import time
from fastapi import APIRouter, Depends, HTTPException
from vibe.auth import get_session
from vibe.db import execute
from vibe.jobs import enqueue
from vibe.video import (
    MAX_DURATION_SECONDS,
    MIN_DURATION_SECONDS,
    UPLOAD_WINDOW_SECONDS,
    _feature_enabled as video_feature_enabled,
)

router = APIRouter(prefix="/api/v1")


@router.post("/submit", status_code=202)
def submit(session=Depends(get_session)):
    if session["status"] not in ("active",):
        raise HTTPException(409, f"Session is {session['status']}")
    submitted_at = int(time.time())
    execute(
        "UPDATE sessions SET status='submitted', submitted_at=? WHERE id=?",
        (submitted_at, session["id"]),
    )
    enqueue(session["id"])
    resp: dict = {"status": "submitted", "message": "Grading queued."}
    if video_feature_enabled():
        resp["video_upload"] = {
            "deadline_unix": submitted_at + UPLOAD_WINDOW_SECONDS,
            "min_duration_seconds": MIN_DURATION_SECONDS,
            "max_duration_seconds": MAX_DURATION_SECONDS,
        }
    return resp
