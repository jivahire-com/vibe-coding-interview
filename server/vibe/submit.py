import time
from fastapi import APIRouter, Depends, HTTPException
from vibe.auth import get_session
from vibe.db import execute
from vibe.jobs import enqueue

router = APIRouter(prefix="/api/v1")


@router.post("/submit", status_code=202)
def submit(session=Depends(get_session)):
    if session["status"] not in ("active",):
        raise HTTPException(409, f"Session is {session['status']}")
    execute(
        "UPDATE sessions SET status='submitted', submitted_at=? WHERE id=?",
        (int(time.time()), session["id"]),
    )
    enqueue(session["id"])
    return {"status": "submitted", "message": "Grading queued."}
