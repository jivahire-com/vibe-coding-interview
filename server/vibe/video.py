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
  :root {{
    color-scheme: light dark;
    --bg: #fafaf9;
    --surface: #ffffff;
    --border: #ebe9e7;
    --border-strong: #d6d3d1;
    --text: #18181b;
    --text-muted: #6b7280;
    --text-subtle: #9ca3af;
    --accent: #18181b;
    --accent-fg: #ffffff;
    --danger: #b91c1c;
    --danger-bg: #fef2f2;
    --danger-border: #fecaca;
    --success: #15803d;
    --rec: #ef4444;
    --radius: 12px;
    --radius-sm: 8px;
  }}
  @media (prefers-color-scheme: dark) {{
    :root {{
      --bg: #0b0b0c;
      --surface: #111113;
      --border: #1f1f23;
      --border-strong: #2a2a2f;
      --text: #f4f4f5;
      --text-muted: #a1a1aa;
      --text-subtle: #6b7280;
      --accent: #f4f4f5;
      --accent-fg: #0b0b0c;
      --danger: #f87171;
      --danger-bg: rgba(248, 113, 113, 0.08);
      --danger-border: rgba(248, 113, 113, 0.25);
      --success: #4ade80;
    }}
  }}

  * {{ box-sizing: border-box; }}
  html, body {{ height: 100%; }}
  body {{
    font-family: 'Inter', ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    margin: 0;
    padding: 56px 24px 80px;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    letter-spacing: -0.011em;
  }}

  .wrap {{ max-width: 600px; margin: 0 auto; }}

  header {{ margin-bottom: 28px; }}
  h1 {{
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin: 0 0 6px;
    line-height: 1.3;
  }}
  .lede {{
    margin: 0;
    color: var(--text-muted);
    font-size: 14.5px;
    line-height: 1.55;
    max-width: 52ch;
  }}

  .card {{
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 24px;
  }}

  .section-label {{
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-subtle);
    margin: 0 0 12px;
  }}

  .points {{
    list-style: none;
    counter-reset: pt;
    padding: 0;
    margin: 0 0 24px;
  }}
  .points li {{
    counter-increment: pt;
    display: flex;
    gap: 12px;
    align-items: flex-start;
    padding: 7px 0;
    font-size: 14px;
    line-height: 1.5;
    color: var(--text);
  }}
  .points li::before {{
    content: counter(pt);
    flex: 0 0 22px;
    height: 22px;
    border-radius: 999px;
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-top: 1px;
    font-variant-numeric: tabular-nums;
  }}

  .stage {{
    position: relative;
    aspect-ratio: 16 / 9;
    background: #0a0a0a;
    border-radius: var(--radius-sm);
    overflow: hidden;
    margin-bottom: 18px;
    box-shadow: inset 0 0 0 1px var(--border);
  }}
  video {{
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    transform: scaleX(-1);
  }}
  .placeholder {{
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: rgba(255,255,255,0.45);
    font-size: 13px;
    gap: 8px;
    pointer-events: none;
    transition: opacity 220ms ease;
  }}
  .placeholder svg {{ width: 18px; height: 18px; }}
  body.has-stream .placeholder {{ opacity: 0; }}

  .rec-pill {{
    position: absolute;
    top: 12px;
    left: 12px;
    display: none;
    align-items: center;
    gap: 7px;
    background: rgba(10,10,10,0.6);
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
    color: #fff;
    padding: 5px 10px 5px 9px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }}
  .rec-pill::before {{
    content: "";
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: var(--rec);
    box-shadow: 0 0 0 0 rgba(239,68,68,0.6);
    animation: pulse 1.4s ease-in-out infinite;
  }}
  body.is-recording .rec-pill {{ display: inline-flex; }}
  @keyframes pulse {{
    0%, 100% {{ opacity: 1; transform: scale(1); }}
    50%      {{ opacity: 0.45; transform: scale(0.8); }}
  }}

  .controls {{
    display: flex;
    align-items: center;
    gap: 8px;
  }}

  button {{
    appearance: none;
    font-family: inherit;
    border: 1px solid transparent;
    background: var(--accent);
    color: var(--accent-fg);
    padding: 10px 14px;
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-weight: 500;
    line-height: 1;
    cursor: pointer;
    transition: opacity 120ms ease, transform 80ms ease, background 120ms ease;
  }}
  button:hover:not(:disabled)  {{ opacity: 0.88; }}
  button:active:not(:disabled) {{ transform: translateY(1px); }}
  button:focus-visible {{
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }}
  button.ghost {{
    background: transparent;
    color: var(--text);
    border-color: var(--border-strong);
  }}
  button.ghost:hover:not(:disabled) {{ background: var(--bg); opacity: 1; }}
  body.is-recording button.ghost {{
    color: var(--rec);
    border-color: color-mix(in srgb, var(--rec) 50%, transparent);
  }}
  button:disabled {{ opacity: 0.4; cursor: not-allowed; }}

  .timer {{
    margin-left: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0;
  }}
  .timer.armed {{ color: var(--text); }}

  .progress {{
    margin-top: 18px;
    height: 3px;
    background: var(--border);
    border-radius: 999px;
    overflow: hidden;
    display: none;
  }}
  .progress.show {{ display: block; }}
  .progress > div {{
    height: 100%;
    background: var(--accent);
    width: 0%;
    transition: width 220ms ease;
  }}

  .status {{
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-muted);
    margin-top: 14px;
    min-height: 18px;
  }}
  .status.error {{
    color: var(--danger);
    background: var(--danger-bg);
    border: 1px solid var(--danger-border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    display: flex;
    align-items: flex-start;
    gap: 9px;
  }}
  .status.error::before {{
    content: "";
    flex: 0 0 14px;
    height: 14px;
    margin-top: 2px;
    background: currentColor;
    -webkit-mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M12 2 1 21h22L12 2zm0 6 7.53 13H4.47L12 8zm-1 4v4h2v-4h-2zm0 6v2h2v-2h-2z'/></svg>") no-repeat center / contain;
            mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M12 2 1 21h22L12 2zm0 6 7.53 13H4.47L12 8zm-1 4v4h2v-4h-2zm0 6v2h2v-2h-2z'/></svg>") no-repeat center / contain;
  }}
  .status.ok {{ color: var(--success); }}

  footer {{
    margin: 20px 0 0;
    text-align: center;
    font-size: 12px;
    color: var(--text-subtle);
  }}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Record a short solution explainer</h1>
    <p class="lede">A brief video helps us verify your identity and gives you a chance to walk us through your thinking.</p>
  </header>

  <main class="card">
    <p class="section-label">What to cover</p>
    <ol class="points" id="prompt-list">
      <li>Loading prompts…</li>
    </ol>

    <div class="stage">
      <div class="placeholder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M23 7l-7 5 7 5V7z"/>
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
        </svg>
        <span>Waiting for camera</span>
      </div>
      <video id="preview" autoplay muted playsinline></video>
      <span class="rec-pill">Rec</span>
    </div>

    <div class="controls">
      <button id="enable">Allow camera &amp; microphone</button>
      <button id="start" disabled hidden>Start recording</button>
      <button id="stop" class="ghost" disabled hidden>Stop</button>
      <span class="timer" id="timer" hidden>0:00</span>
    </div>

    <div class="progress" id="progress"><div></div></div>
    <div class="status" id="status">Click "Allow camera &amp; microphone" — your browser will ask for permission.</div>
    <div id="help" class="status" hidden></div>
  </main>

  <footer>Uploaded directly and securely. Only the interview team can view this recording.</footer>
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

  const enableBtn = $('enable');
  const helpEl = $('help');

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

  function setHelp(html) {{
    if (!html) {{ helpEl.hidden = true; helpEl.innerHTML = ''; return; }}
    helpEl.hidden = false;
    helpEl.innerHTML = html;
    helpEl.className = 'status';
  }}

  // Distinguish DOMException names so we can hand the candidate something
  // they can act on. NotAllowedError is the most common — the browser has
  // either remembered a previous "Block" choice, the OS has revoked
  // permission, or an enterprise policy is in the way.
  function explainCameraError(err) {{
    const name = (err && err.name) ? err.name : String(err);
    const ua = navigator.userAgent;
    const isMac = /Mac OS X/i.test(ua);
    const isChrome = /Chrome|Edg/.test(ua) && !/Firefox/.test(ua);
    const isFirefox = /Firefox/.test(ua);
    const isSafari = /Safari/.test(ua) && !/Chrome|Edg/.test(ua);

    if (name === 'NotAllowedError' || name === 'SecurityError') {{
      const steps = [];
      if (isChrome) {{
        steps.push('Click the <strong>lock icon</strong> next to the URL bar, choose <strong>Site settings</strong>, set <strong>Camera</strong> and <strong>Microphone</strong> to <strong>Allow</strong>, then reload this page.');
      }} else if (isFirefox) {{
        steps.push('Click the <strong>lock icon</strong> next to the URL bar, click the <strong>×</strong> next to any "Blocked" camera/microphone entry, then reload this page.');
      }} else if (isSafari) {{
        steps.push('Open <strong>Safari → Settings → Websites → Camera / Microphone</strong>, set this site to <strong>Allow</strong>, then reload.');
      }} else {{
        steps.push('Open your browser\\'s site settings for this page and set Camera and Microphone to <strong>Allow</strong>, then reload.');
      }}
      if (isMac) {{
        steps.push('On macOS also check <strong>System Settings → Privacy &amp; Security → Camera / Microphone</strong> and make sure your browser is checked.');
      }}
      steps.push('Or open this link on a phone or another device with a camera.');
      return {{
        title: 'Camera and microphone are blocked',
        body: 'Your browser is blocking access — most often because permission was denied earlier and the choice was remembered.',
        steps: steps,
      }};
    }}
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {{
      return {{
        title: 'No camera or microphone detected',
        body: 'This device does not seem to have a working camera or microphone.',
        steps: ['Open this link on a phone or another device that has a camera.'],
      }};
    }}
    if (name === 'NotReadableError' || name === 'TrackStartError') {{
      return {{
        title: 'Camera or microphone is in use',
        body: 'Another app is currently using your camera or microphone.',
        steps: ['Close any video-call, screen-recording or meeting apps, then click "Try again".'],
      }};
    }}
    return {{
      title: 'Could not start the camera',
      body: 'Error: ' + name,
      steps: ['Reload the page and try again, or open this link on another device.'],
    }};
  }}

  function renderHelp(info) {{
    const lis = info.steps.map((s) => '<li>' + s + '</li>').join('');
    // Wrap in a single <div> so the .status.error flex layout treats the
    // whole block (heading + body + steps + button) as one flex child
    // beside the warning ::before icon — otherwise each tag becomes its
    // own flex item and they lay out side-by-side.
    setHelp(
      '<div>' +
        '<strong>' + info.title + '</strong><br>' +
        info.body +
        '<ol style="margin: 8px 0 0; padding-left: 20px;">' + lis + '</ol>' +
        '<button id="retry" style="margin-top: 10px;">Try again</button>' +
      '</div>'
    );
    helpEl.classList.add('error');
    const retry = document.getElementById('retry');
    if (retry) retry.addEventListener('click', () => {{
      setHelp('');
      setStatus('Requesting camera access…');
      requestCamera();
    }});
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
    }} catch (e) {{
      setStatus(e.message || String(e), 'error');
      promptList.innerHTML = '<li>Video upload unavailable.</li>';
      enableBtn.disabled = true;
    }}
  }}

  // Trigger getUserMedia from a real user gesture (button click). Some
  // browsers (notably Safari/iOS) only show the permission prompt when the
  // call originates inside a user gesture; calling on page load can
  // silently reject as NotAllowedError without ever asking the user.
  enableBtn.addEventListener('click', () => {{
    if (!initData) {{
      setStatus('Still loading — try again in a moment.', 'error');
      return;
    }}
    enableBtn.disabled = true;
    setStatus('Requesting camera access…');
    requestCamera();
  }});

  async function requestCamera() {{
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {{
      setStatus('This browser does not support recording.', 'error');
      renderHelp({{
        title: 'Recording not supported in this browser',
        body: 'navigator.mediaDevices.getUserMedia is unavailable.',
        steps: ['Open this link in an up-to-date Chrome, Edge, Firefox or Safari.'],
      }});
      enableBtn.disabled = false;
      return;
    }}
    try {{
      mediaStream = await navigator.mediaDevices.getUserMedia({{ video: true, audio: true }});
      preview.srcObject = mediaStream;
      document.body.classList.add('has-stream');
      enableBtn.hidden = true;
      startBtn.hidden = false;
      stopBtn.hidden = false;
      timerEl.hidden = false;
      startBtn.disabled = false;
      setStatus('Camera ready. Press "Start recording" when you are ready (min ' + minDur + 's, max ' + maxDur + 's).');
      setHelp('');
    }} catch (err) {{
      const info = explainCameraError(err);
      setStatus(info.title, 'error');
      renderHelp(info);
      enableBtn.disabled = false;
      enableBtn.textContent = 'Try permission prompt again';
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
    document.body.classList.add('is-recording');
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
    document.body.classList.remove('is-recording');
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
