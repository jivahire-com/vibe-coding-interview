"""Post-submit identity-verification video.

Two authentication paths reach the same upload pipeline:

- Session-authed (extension WebviewPanel):
    POST /api/v1/video/init / complete  — Bearer session_key.
- Token-authed (browser fallback link, e.g. from a phone):
    POST /api/v1/video/browser-link     — mints a short-lived token URL.
    POST /api/v1/video/browser/init     — exchanges token → presigned PUT.
    POST /api/v1/video/browser/complete — finalises the upload.
    GET  /video-record                  — public HTML recording page.

Recruiter playback:
    GET  /api/v1/sessions/{id}/video-url — admin-only CloudFront URL.

Playback URLs are public (no signing). The CloudFront distribution is
public-read; anyone with the link can view the video. The DB stores
only the S3 key, so the URL is derivable but not enumerable. boto3
picks AWS credentials up from the standard chain (IAM role on ECS/EC2,
then env vars). When the bucket or CloudFront domain is blank, the
feature is disabled and init returns 503.
"""
import hashlib
import secrets
import time
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from vibe.auth import get_session
from vibe.config import settings
from vibe.db import execute, query

router = APIRouter(prefix="/api/v1")
# Non-prefixed router for the public browser recording page. main.py must
# include this BEFORE the static mount, since StaticFiles("/") would shadow it.
public_router = APIRouter()

UPLOAD_WINDOW_SECONDS = 600       # 10 min from submitted_at
MIN_DURATION_SECONDS = 30
MAX_DURATION_SECONDS = 300
PRESIGNED_PUT_TTL_SECONDS = 600   # match upload window
BROWSER_LINK_TTL_SECONDS = 900    # 15 min; further bounded by UPLOAD_WINDOW_SECONDS
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
        from botocore.client import Config
        # Force SigV4 — boto3 defaults the global "s3.amazonaws.com" endpoint
        # to the deprecated SigV2 signer, which AWS is phasing out.
        _s3_client = boto3.client(
            "s3",
            region_name=settings.aws_region,
            config=Config(signature_version="s3v4"),
        )
    return _s3_client


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _resolve_token(token: str) -> dict:
    """Return the session row for an unused, unexpired token. Maps any
    validation failure to a candidate-safe HTTPException."""
    if not token or len(token) < 16:
        raise HTTPException(401, "Invalid recording link")
    rows = query(
        "SELECT * FROM video_upload_tokens WHERE token_hash = ?",
        (_hash_token(token),),
    )
    if not rows:
        raise HTTPException(401, "Recording link is invalid or has been revoked")
    tok = rows[0]
    if tok["used_at"]:
        raise HTTPException(409, "This recording link has already been used")
    if int(time.time()) > tok["expires_at"]:
        raise HTTPException(410, "Recording link has expired — request a new one")
    sess = query("SELECT * FROM sessions WHERE id = ?", (tok["session_id"],))
    if not sess:
        raise HTTPException(404, "Session no longer exists")
    return sess[0]


def _check_upload_preconditions(session: dict) -> int:
    """Shared precondition check for init endpoints. Returns the upload
    deadline (epoch seconds)."""
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
    return deadline


def _mint_presigned_put(session_id: str) -> tuple[str, str]:
    """Returns (presigned_put_url, s3_key)."""
    # "static/" prefix matches the CloudFront cache behavior named "static"
    # that routes /static/* to this S3 origin.
    key = f"static/videos/{session_id}/{uuid.uuid4().hex}.webm"
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
    return url, key


def _finalise_upload(session: dict, s3_key: str, duration_seconds: int) -> None:
    """Validate the completed S3 object and record it on the session row.
    Raises HTTPException on any validation failure."""
    if not _feature_enabled():
        raise HTTPException(503, "Video upload not configured on this server")
    if not s3_key.startswith(f"static/videos/{session['id']}/"):
        raise HTTPException(403, "s3_key does not belong to this session")
    if not (MIN_DURATION_SECONDS <= duration_seconds <= MAX_DURATION_SECONDS):
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
        _s3().head_object(Bucket=settings.s3_video_bucket, Key=s3_key)
    except Exception:
        raise HTTPException(404, "Uploaded video not found in storage")

    execute(
        "UPDATE sessions SET video_s3_key=?, video_uploaded_at=?, video_duration_seconds=? WHERE id=?",
        (s3_key, int(time.time()), duration_seconds, session["id"]),
    )


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


class BrowserInitRequest(BaseModel):
    token: str


class BrowserCompleteRequest(BaseModel):
    token: str
    s3_key: str
    duration_seconds: int


class BrowserLinkResponse(BaseModel):
    url: str
    expires_unix: int


# ──────────────────────────────────────────────────────────────────────
# Session-authed endpoints (used by the VS Code WebviewPanel)
# ──────────────────────────────────────────────────────────────────────
@router.post("/video/init", response_model=InitResponse)
def video_init(session=Depends(get_session)) -> InitResponse:
    deadline = _check_upload_preconditions(session)
    url, key = _mint_presigned_put(session["id"])
    return InitResponse(upload_url=url, s3_key=key, deadline_unix=deadline)


@router.post("/video/complete")
def video_complete(req: CompleteRequest, session=Depends(get_session)):
    _finalise_upload(session, req.s3_key, req.duration_seconds)
    return {"status": "stored"}


# ──────────────────────────────────────────────────────────────────────
# Browser-link flow — for candidates whose VS Code host has no camera
# (broken hardware, headless container, etc.). The extension mints a
# token, opens the URL in the default browser, and the candidate can
# also forward the URL to a phone.
# ──────────────────────────────────────────────────────────────────────
@router.post("/video/browser-link", response_model=BrowserLinkResponse)
def browser_link(session=Depends(get_session)) -> BrowserLinkResponse:
    upload_deadline = _check_upload_preconditions(session)
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    # Never outlive the underlying upload window; if the candidate has only
    # 3 min left to upload, the link expires in 3 min, not 15.
    expires = min(now + BROWSER_LINK_TTL_SECONDS, upload_deadline)
    execute(
        "INSERT INTO video_upload_tokens (token_hash, session_id, created_at, expires_at)"
        " VALUES (?, ?, ?, ?)",
        (_hash_token(token), session["id"], now, expires),
    )
    base = settings.app_public_url.rstrip("/")
    return BrowserLinkResponse(url=f"{base}/video-record?t={token}", expires_unix=expires)


@router.post("/video/browser/init", response_model=InitResponse)
def browser_video_init(req: BrowserInitRequest) -> InitResponse:
    session = _resolve_token(req.token)
    deadline = _check_upload_preconditions(session)
    url, key = _mint_presigned_put(session["id"])
    return InitResponse(upload_url=url, s3_key=key, deadline_unix=deadline)


@router.post("/video/browser/complete")
def browser_video_complete(req: BrowserCompleteRequest):
    session = _resolve_token(req.token)
    _finalise_upload(session, req.s3_key, req.duration_seconds)
    # Single-use: mark the token consumed so a stolen link can't replay.
    execute(
        "UPDATE video_upload_tokens SET used_at=? WHERE token_hash=?",
        (int(time.time()), _hash_token(req.token)),
    )
    return {"status": "stored"}


# ──────────────────────────────────────────────────────────────────────
# Recruiter playback
# ──────────────────────────────────────────────────────────────────────
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


# ──────────────────────────────────────────────────────────────────────
# Public HTML recording page (browser fallback)
# ──────────────────────────────────────────────────────────────────────
@public_router.get("/video-record", include_in_schema=False)
def video_record_page(t: str = "") -> HTMLResponse:
    # We validate the token here only to surface a friendly error page; the
    # actual init/complete endpoints re-validate, so we can't bypass anything
    # by skipping this check.
    if not t:
        return HTMLResponse(_render_error_page("Missing recording link token."), status_code=400)
    try:
        _resolve_token(t)
    except HTTPException as e:
        return HTMLResponse(_render_error_page(e.detail), status_code=e.status_code)
    return HTMLResponse(_render_record_page(t))


def _render_error_page(message: str) -> str:
    safe = (
        message.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recording link unavailable</title>
<style>
body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
       background: #f7f7f8; color: #222; margin: 0; padding: 24px;
       display: flex; align-items: center; justify-content: center; min-height: 100vh; }}
.card {{ background: #fff; max-width: 480px; padding: 28px; border-radius: 8px;
        box-shadow: 0 1px 3px rgba(0,0,0,.08); text-align: center; }}
h1 {{ font-size: 20px; margin: 0 0 12px; }}
p {{ margin: 0; color: #555; line-height: 1.5; }}
</style></head><body>
<div class="card"><h1>Recording link unavailable</h1><p>{safe}</p></div>
</body></html>"""


def _render_record_page(token: str) -> str:
    # The token is embedded in a JS string literal. token_urlsafe is base64url
    # (a-z, A-Z, 0-9, -, _) so it cannot break out of the JSON string, but we
    # still serialise via json.dumps for defence in depth.
    import json
    token_js = json.dumps(token)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Record solution explainer</title>
<style>
  :root {{ color-scheme: light dark; }}
  * {{ box-sizing: border-box; }}
  body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         background: #f7f7f8; color: #222; margin: 0; padding: 16px;
         max-width: 720px; margin-left: auto; margin-right: auto; }}
  @media (prefers-color-scheme: dark) {{
    body {{ background: #1e1e1e; color: #eee; }}
    .card {{ background: #2a2a2a; }}
    .prompts {{ background: #333; border-color: #555; }}
    .status {{ color: #ccc; }}
  }}
  .card {{ background: #fff; padding: 20px; border-radius: 8px;
          box-shadow: 0 1px 3px rgba(0,0,0,.08); margin-bottom: 16px; }}
  h1 {{ font-size: 20px; margin: 0 0 4px; }}
  .sub {{ color: #666; margin: 0 0 16px; font-size: 14px; }}
  .prompts {{ background: #f0f4ff; border-left: 3px solid #5066ff;
             padding: 12px 16px; border-radius: 4px; margin-bottom: 16px; }}
  .prompts strong {{ font-size: 13px; }}
  .prompts ol {{ margin: 4px 0 0 18px; padding: 0; }}
  .prompts li {{ margin: 4px 0; font-size: 14px; }}
  video {{ width: 100%; background: #000; border-radius: 6px;
          aspect-ratio: 16 / 9; display: block; }}
  .controls {{ display: flex; gap: 8px; align-items: center; margin: 12px 0;
              flex-wrap: wrap; }}
  button {{ background: #2563eb; color: #fff; border: none;
           padding: 10px 16px; border-radius: 6px; cursor: pointer;
           font-size: 14px; font-weight: 500; }}
  button.secondary {{ background: #6b7280; }}
  button:disabled {{ opacity: 0.5; cursor: not-allowed; }}
  .timer {{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
           font-size: 16px; margin-left: auto; color: #666; }}
  .timer.armed {{ color: #dc2626; }}
  .progress {{ width: 100%; height: 8px; background: #e5e7eb;
              border-radius: 4px; overflow: hidden; margin: 12px 0;
              display: none; }}
  .progress.show {{ display: block; }}
  .progress > div {{ height: 100%; background: #2563eb; width: 0%;
                    transition: width 0.2s ease; }}
  .status {{ font-size: 13px; margin: 12px 0; min-height: 18px; color: #444; }}
  .error {{ color: #dc2626; }}
  .ok {{ color: #16a34a; }}
</style>
</head>
<body>
<div class="card">
  <h1>Record a short solution explainer</h1>
  <p class="sub">This brief video helps us verify identity and gives you a chance to walk through your thinking.</p>

  <div class="prompts">
    <strong>What to cover</strong>
    <ol id="prompt-list"><li>Loading prompts…</li></ol>
  </div>

  <video id="preview" autoplay muted playsinline></video>

  <div class="controls">
    <button id="start" disabled>Start recording</button>
    <button id="stop" class="secondary" disabled>Stop</button>
    <span class="timer" id="timer">0:00</span>
  </div>

  <div class="progress" id="progress"><div></div></div>
  <div class="status" id="status">Requesting camera access…</div>
</div>

<script>
(function() {{
  const TOKEN = {token_js};
  const $ = (id) => document.getElementById(id);
  const promptList = $('prompt-list');
  const preview = $('preview');
  const startBtn = $('start');
  const stopBtn = $('stop');
  const timerEl = $('timer');
  const progressEl = $('progress');
  const progressBar = progressEl.firstElementChild;
  const statusEl = $('status');

  let initData = null;
  let mediaStream = null;
  let recorder = null;
  let chunks = [];
  let startedAt = 0;
  let timerInterval = null;
  let minDur = 30;
  let maxDur = 300;

  function setStatus(msg, cls) {{
    statusEl.textContent = msg;
    statusEl.className = 'status ' + (cls || '');
  }}

  function fmt(seconds) {{
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }}

  async function postJSON(url, body) {{
    const res = await fetch(url, {{
      method: 'POST',
      headers: {{ 'Content-Type': 'application/json' }},
      body: JSON.stringify(body),
    }});
    if (!res.ok) {{
      let detail = res.statusText;
      try {{ const j = await res.json(); detail = j.detail || detail; }} catch (e) {{}}
      throw new Error(detail || ('HTTP ' + res.status));
    }}
    return res.json();
  }}

  async function bootstrap() {{
    try {{
      initData = await postJSON('/api/v1/video/browser/init', {{ token: TOKEN }});
      minDur = initData.min_duration_seconds || 30;
      maxDur = initData.max_duration_seconds || 300;
      promptList.innerHTML = '';
      (initData.prompts || []).forEach((p) => {{
        const li = document.createElement('li');
        li.textContent = p;
        promptList.appendChild(li);
      }});
      requestCamera();
    }} catch (e) {{
      setStatus(e.message || String(e), 'error');
      promptList.innerHTML = '<li>Video upload unavailable.</li>';
    }}
  }}

  async function requestCamera() {{
    try {{
      mediaStream = await navigator.mediaDevices.getUserMedia({{ video: true, audio: true }});
      preview.srcObject = mediaStream;
      startBtn.disabled = false;
      setStatus('Camera ready. Press "Start recording" when you are ready (min ' + minDur + 's, max ' + maxDur + 's).');
    }} catch (err) {{
      const name = (err && err.name) ? err.name : String(err);
      setStatus('Camera or microphone unavailable: ' + name + '. Make sure you granted permission and that a device is connected.', 'error');
    }}
  }}

  startBtn.addEventListener('click', () => {{
    if (!mediaStream) return;
    chunks = [];
    const mime = pickMime();
    try {{
      recorder = mime ? new MediaRecorder(mediaStream, {{ mimeType: mime }}) : new MediaRecorder(mediaStream);
    }} catch (e) {{
      setStatus('MediaRecorder unavailable: ' + e, 'error');
      return;
    }}
    recorder.addEventListener('dataavailable', (e) => {{
      if (e.data && e.data.size > 0) chunks.push(e.data);
    }});
    recorder.addEventListener('stop', onRecorderStop);
    recorder.start();
    startedAt = Date.now();
    startBtn.disabled = true;
    stopBtn.disabled = true;
    setStatus('Recording… you can stop after ' + minDur + 's.');
    timerInterval = setInterval(updateTimer, 200);
  }});

  stopBtn.addEventListener('click', () => {{
    if (recorder && recorder.state === 'recording') recorder.stop();
  }});

  function pickMime() {{
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    for (const c of candidates) {{
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
    }}
    return '';
  }}

  function updateTimer() {{
    const elapsed = (Date.now() - startedAt) / 1000;
    timerEl.textContent = fmt(elapsed) + ' / ' + fmt(maxDur);
    if (elapsed >= minDur) {{
      stopBtn.disabled = false;
      timerEl.classList.add('armed');
    }}
    if (elapsed >= maxDur) {{
      if (recorder && recorder.state === 'recording') recorder.stop();
    }}
  }}

  function onRecorderStop() {{
    clearInterval(timerInterval);
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
    stopBtn.disabled = true;
    startBtn.disabled = true;

    if (elapsedSec < minDur) {{
      setStatus('Recording was too short (' + elapsedSec + 's). Please reload and try again.', 'error');
      return;
    }}
    if (!initData) {{
      setStatus('Upload session lost — please reload.', 'error');
      return;
    }}

    const blob = new Blob(chunks, {{ type: chunks[0] && chunks[0].type ? chunks[0].type : 'video/webm' }});
    uploadToS3(blob, elapsedSec);
  }}

  function uploadToS3(blob, durationSec) {{
    setStatus('Uploading… ' + Math.round(blob.size / 1024 / 1024 * 10) / 10 + ' MB');
    progressEl.classList.add('show');
    progressBar.style.width = '0%';

    const xhr = new XMLHttpRequest();
    xhr.open('PUT', initData.upload_url, true);
    xhr.setRequestHeader('Content-Type', 'video/webm');
    xhr.upload.addEventListener('progress', (e) => {{
      if (e.lengthComputable) {{
        progressBar.style.width = ((e.loaded / e.total) * 100).toFixed(1) + '%';
      }}
    }});
    xhr.addEventListener('load', async () => {{
      if (xhr.status >= 200 && xhr.status < 300) {{
        progressBar.style.width = '100%';
        setStatus('Finalizing…');
        try {{
          await postJSON('/api/v1/video/browser/complete', {{
            token: TOKEN,
            s3_key: initData.s3_key,
            duration_seconds: durationSec,
          }});
          setStatus('Upload complete. Thank you! You can close this tab.', 'ok');
        }} catch (e) {{
          setStatus('Could not finalize upload: ' + e.message, 'error');
        }}
      }} else {{
        setStatus('Upload failed (status ' + xhr.status + '). Please reload to retry.', 'error');
      }}
    }});
    xhr.addEventListener('error', () => {{
      setStatus('Network error during upload. Please reload to retry.', 'error');
    }});
    xhr.send(blob);
  }}

  bootstrap();
}})();
</script>
</body>
</html>"""
