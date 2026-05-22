"""Post-submit identity-verification video.

Three endpoints:
- POST /api/v1/video/init     — candidate asks for a presigned S3 PUT URL.
- POST /api/v1/video/complete — candidate confirms the upload finished.
- GET  /api/v1/sessions/{id}/video-url — recruiter fetches the public
  CloudFront URL for playback.

Playback URLs are public (no signing). The CloudFront distribution is
public-read; anyone with the link can view the video. The DB stores
only the S3 key, so the URL is derivable but not enumerable. boto3
picks AWS credentials up from the standard chain (IAM role on ECS/EC2,
then env vars). When the bucket or CloudFront domain is blank, the
feature is disabled and init returns 503.
"""
import time
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from vibe.auth import get_session
from vibe.config import settings
from vibe.db import execute, query

router = APIRouter(prefix="/api/v1")

UPLOAD_WINDOW_SECONDS = 600       # 10 min from submitted_at
MIN_DURATION_SECONDS = 30
MAX_DURATION_SECONDS = 300
PRESIGNED_PUT_TTL_SECONDS = 600   # match upload window
STATIC_PROMPTS = [
    "Briefly introduce yourself — full name and current role.",
    "Walk us through the most interesting decision in your solution.",
    "Explain one tradeoff you made and why.",
]


# Lazy boto3 client — importing boto3 at module load would fail in test
# environments without the dep, so we defer until the feature is used.
_s3_client = None


def _feature_enabled() -> bool:
    return bool(settings.s3_video_bucket and settings.cloudfront_domain)


def _s3():
    global _s3_client
    if _s3_client is None:
        import boto3
        _s3_client = boto3.client("s3", region_name=settings.aws_region)
    return _s3_client


# ──────────────────────────────────────────────────────────────────────
# Request / response models
# ──────────────────────────────────────────────────────────────────────
class InitResponse(BaseModel):
    upload_url: str
    s3_key: str
    deadline_unix: int
    min_duration_seconds: int = MIN_DURATION_SECONDS
    max_duration_seconds: int = MAX_DURATION_SECONDS
    prompts: list[str] = Field(default_factory=lambda: list(STATIC_PROMPTS))


class CompleteRequest(BaseModel):
    s3_key: str
    duration_seconds: int


# ──────────────────────────────────────────────────────────────────────
# Endpoints
# ──────────────────────────────────────────────────────────────────────
@router.post("/video/init", response_model=InitResponse)
def video_init(session=Depends(get_session)) -> InitResponse:
    if not _feature_enabled():
        raise HTTPException(503, "Video upload not configured on this server")

    if session["status"] not in ("submitted", "graded", "grading_failed"):
        raise HTTPException(
            409,
            f"Session must be submitted before recording video (current: {session['status']})",
        )
    if session.get("video_s3_key"):
        raise HTTPException(409, "Video already uploaded for this session")

    submitted_at = session.get("submitted_at") or 0
    deadline = submitted_at + UPLOAD_WINDOW_SECONDS
    if int(time.time()) > deadline:
        raise HTTPException(410, "Video upload window has closed (10 minutes after submit)")

    key = f"videos/{session['id']}/{uuid.uuid4().hex}.webm"
    try:
        url = _s3().generate_presigned_url(
            "put_object",
            Params={
                "Bucket": settings.s3_video_bucket,
                "Key": key,
                "ContentType": "video/webm",
            },
            ExpiresIn=PRESIGNED_PUT_TTL_SECONDS,
        )
    except Exception as e:
        raise HTTPException(502, f"Could not generate upload URL: {e}")

    return InitResponse(
        upload_url=url,
        s3_key=key,
        deadline_unix=deadline,
    )


@router.post("/video/complete")
def video_complete(req: CompleteRequest, session=Depends(get_session)):
    if not _feature_enabled():
        raise HTTPException(503, "Video upload not configured on this server")

    if not req.s3_key.startswith(f"videos/{session['id']}/"):
        raise HTTPException(403, "s3_key does not belong to this session")
    if not (MIN_DURATION_SECONDS <= req.duration_seconds <= MAX_DURATION_SECONDS):
        raise HTTPException(
            400,
            f"duration_seconds must be {MIN_DURATION_SECONDS}–{MAX_DURATION_SECONDS}",
        )

    submitted_at = session.get("submitted_at") or 0
    if int(time.time()) > submitted_at + UPLOAD_WINDOW_SECONDS:
        raise HTTPException(410, "Video upload window has closed")

    # head_object confirms the candidate actually completed the PUT; without
    # this we'd happily store a key pointing at nothing.
    try:
        _s3().head_object(Bucket=settings.s3_video_bucket, Key=req.s3_key)
    except Exception:
        raise HTTPException(404, "Uploaded video not found in storage")

    execute(
        "UPDATE sessions SET video_s3_key=?, video_uploaded_at=?, video_duration_seconds=? WHERE id=?",
        (req.s3_key, int(time.time()), req.duration_seconds, session["id"]),
    )
    return {"status": "stored"}


@router.get("/sessions/{session_id}/video-url")
def video_playback_url(session_id: str, x_admin_token: str = Header(None)):
    if x_admin_token != settings.admin_token:
        raise HTTPException(401, "Unauthorized")
    if not _feature_enabled():
        raise HTTPException(503, "Video playback not configured on this server")

    rows = query(
        "SELECT video_s3_key, video_uploaded_at, video_duration_seconds "
        "FROM sessions WHERE id = ?",
        (session_id,),
    )
    if not rows:
        raise HTTPException(404, "Session not found")
    row = rows[0]
    if not row["video_s3_key"]:
        raise HTTPException(404, "No video uploaded for this session")

    return {
        "video_url": f"https://{settings.cloudfront_domain}/{row['video_s3_key']}",
        "duration_seconds": row["video_duration_seconds"],
        "uploaded_at": row["video_uploaded_at"],
    }
