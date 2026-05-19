import base64
import logging
import uuid
from datetime import datetime, timezone
import httpx
from vibe.config import settings

log = logging.getLogger(__name__)


def _ics_escape(s: str) -> str:
    """Escape a string for an .ics TEXT-typed property (RFC 5545 §3.3.11)."""
    return (
        s.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\n", "\\n")
    )


def _format_utc(epoch: int) -> str:
    """Format an epoch second as a UTC iCalendar timestamp (e.g. 20260520T140000Z)."""
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _build_ics(
    *,
    session_id: str,
    scheduled_at: int,
    max_minutes: int,
    challenge_id: str,
    meet_link: str | None,
    organizer_email: str,
    attendee_emails: list[str],
) -> str:
    """Generate a minimal RFC 5545 VEVENT for the interview. Single source of
    truth for the time — candidate + panelists all get the same UID so calendar
    clients dedupe across replies."""
    dtstart = _format_utc(scheduled_at)
    dtend = _format_utc(scheduled_at + max_minutes * 60)
    dtstamp = _format_utc(int(datetime.now(tz=timezone.utc).timestamp()))
    uid = f"{session_id}@jivahire"
    summary = _ics_escape(f"JivaHire Coding Interview — {challenge_id}")
    description_parts = [
        f"Challenge: {challenge_id}",
        f"Duration: {max_minutes} minutes",
    ]
    if meet_link:
        description_parts.append(f"Video call: {meet_link}")
    description = _ics_escape("\n".join(description_parts))
    location = _ics_escape(meet_link or "")
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//JivaHire//Interview//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        f"UID:{uid}",
        f"DTSTAMP:{dtstamp}",
        f"DTSTART:{dtstart}",
        f"DTEND:{dtend}",
        f"SUMMARY:{summary}",
        f"DESCRIPTION:{description}",
        f"LOCATION:{location}",
        f"ORGANIZER:mailto:{organizer_email}",
    ]
    for email in attendee_emails:
        lines.append(
            f"ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:{email}"
        )
    lines += ["STATUS:CONFIRMED", "END:VEVENT", "END:VCALENDAR"]
    # RFC 5545 mandates CRLF line endings.
    return "\r\n".join(lines) + "\r\n"


def _format_human_time(epoch: int) -> str:
    """Render an epoch second as 'Wed, May 20, 2026 at 14:00 UTC' — UTC only,
    so the email body is unambiguous regardless of recipient timezone. The
    attached .ics is what converts to each recipient's local calendar time."""
    dt = datetime.fromtimestamp(epoch, tz=timezone.utc)
    return dt.strftime("%a, %b %-d, %Y at %H:%M UTC")


def _sendgrid_attachment(content: str, filename: str, mime_type: str) -> dict:
    """Build a SendGrid attachment dict from a string payload."""
    return {
        "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
        "type": mime_type,
        "filename": filename,
        "disposition": "attachment",
        "content_id": uuid.uuid4().hex,
    }


async def send_invite(
    to_email: str,
    session_key: str,
    challenge_id: str,
    max_minutes: int,
    budget_usd: float,
    meet_link: str | None = None,
    scheduled_at: int | None = None,
    session_id: str | None = None,
) -> None:
    if not settings.sendgrid_api_key:
        log.info("SendGrid key not set — skipping invite email to %s", to_email)
        return

    subject = "Your JivaHire Coding Interview Invitation"
    vsix_url = f"{settings.app_public_url}/jivahire-vibe-coding-interview.vsix"

    # Scheduled-at block (rendered when the recruiter pinned a start time).
    scheduled_text_block = ""
    scheduled_html_block = ""
    if scheduled_at is not None:
        human_time = _format_human_time(scheduled_at)
        scheduled_text_block = f"""
Scheduled:    {human_time}
              (See the attached calendar invite to add this to your calendar
              in your local timezone.)
"""
        scheduled_html_block = f"""
  <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Scheduled</td>
      <td><strong>{human_time}</strong><br>
          <span style="font-size:0.85em;color:#6b7280">Open the attached
          <code>interview.ics</code> to add this to your calendar in your
          local timezone.</span></td></tr>"""

    # Panel interview: when a video meeting link is attached, the candidate
    # joins live and shares their screen. The block is appended to the existing
    # email templates only when set — async sessions stay unchanged.
    meet_text_block = ""
    meet_html_block = ""
    if meet_link:
        meet_text_block = f"""
────────────────────────────────────────
LIVE VIDEO INTERVIEW
────────────────────────────────────────
This is a panel interview. Join the video call below at the
scheduled time and SHARE YOUR SCREEN so the interviewers can
follow along while you code.

Video call link:  {meet_link}

"""
        meet_html_block = f"""
<h3 style="margin-top:28px;color:#111827">Live video interview</h3>
<p>This is a <strong>panel interview</strong>. Join the video call
below at the scheduled time and <strong>share your screen</strong>
so the interviewers can follow along while you code.</p>
<p><a href="{meet_link}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:600">Join video call</a></p>
<p style="font-size:0.9em;color:#6b7280">Or copy this link: <a href="{meet_link}">{meet_link}</a></p>
"""

    text_body = f"""Hi,

You've been invited to complete a coding interview on the JivaHire platform.
Save this email — you'll need the session key below to start.

Session Key:  {session_key}
Challenge:    {challenge_id}
Time Limit:   {max_minutes} minutes
AI Budget:    ${budget_usd:.2f}
{scheduled_text_block}{meet_text_block}
────────────────────────────────────────
STEP 1 — Install VS Code (skip if you already have it)
────────────────────────────────────────
Download and install from https://code.visualstudio.com
(Free, available on Windows, macOS, and Linux.)


────────────────────────────────────────
STEP 2 — Install the JivaHire extension
────────────────────────────────────────
First, download the extension file (.vsix):
  {vsix_url}

Then install it in VS Code using ONE of these methods:

  Method A (recommended — graphical):
    1. Open VS Code.
    2. Click the Extensions icon in the left sidebar (four squares),
       or press Ctrl+Shift+X (Cmd+Shift+X on Mac).
    3. At the top of the Extensions panel, click the "..." menu
       and choose "Install from VSIX...".
    4. Select the .vsix file you downloaded.

  Method B (one command, terminal):
    Run this in your terminal:
       code --install-extension /path/to/jivahire-vibe-coding-interview.vsix


────────────────────────────────────────
STEP 3 — Start your interview
────────────────────────────────────────
1. After install, look at the left edge of VS Code (the Activity Bar).
   You should see a new JivaHire icon — a small cube with a tie.
   Click it to open the JivaHire sidebar.

2. In the JivaHire sidebar, click "Start Interview" (or open the
   Command Palette with Ctrl+Shift+P / Cmd+Shift+P and run
   "JivaHire: Enter Session Key").

3. When prompted for the JivaHire server URL, just press Enter to
   accept the default (https://interview.jivahire.com). Do NOT
   change it unless your recruiter told you to.

4. Paste the session key above when prompted: {session_key}

5. Your challenge workspace will clone automatically and a new
   VS Code window will open with the code. The timer starts when
   the workspace opens.


Need help? Reply to this email and we'll get back to you.

Good luck!

— The JivaHire Team
"""
    html_body = f"""<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;color:#111827;line-height:1.55">
<p>Hi,</p>
<p>You've been invited to complete a coding interview on the <strong>JivaHire</strong> platform.
Save this email &mdash; you'll need the session key below to start.</p>

<table style="border-collapse:collapse;margin:16px 0">
  <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Session Key</td>
      <td><code style="background:#f3f4f6;padding:4px 8px;border-radius:4px;font-size:1.1em">{session_key}</code></td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Challenge</td><td>{challenge_id}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Time Limit</td><td>{max_minutes} minutes</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#6b7280">AI Budget</td><td>${budget_usd:.2f}</td></tr>{scheduled_html_block}
</table>
{meet_html_block}
<h3 style="margin-top:28px;color:#111827">Step 1 &mdash; Install VS Code</h3>
<p>Skip this step if you already have it. Otherwise, download and install
from <a href="https://code.visualstudio.com">code.visualstudio.com</a>
(free; Windows, macOS, Linux).</p>

<h3 style="margin-top:28px;color:#111827">Step 2 &mdash; Install the JivaHire extension</h3>
<p>First, download the extension file (.vsix):<br>
<a href="{vsix_url}">{vsix_url}</a></p>

<p>Then install it in VS Code using <strong>one</strong> of these methods:</p>

<p><strong>Method A (recommended &mdash; graphical):</strong></p>
<ol>
  <li>Open VS Code.</li>
  <li>Click the <strong>Extensions</strong> icon in the left sidebar (four squares),
      or press <kbd>Ctrl+Shift+X</kbd> (<kbd>Cmd+Shift+X</kbd> on Mac).</li>
  <li>At the top of the Extensions panel, click the <strong>&hellip;</strong> menu
      and choose <em>Install from VSIX&hellip;</em></li>
  <li>Select the <code>.vsix</code> file you downloaded.</li>
</ol>

<p><strong>Method B (one command, terminal):</strong></p>
<pre style="background:#f3f4f6;padding:10px 14px;border-radius:6px;font-size:0.95em;overflow-x:auto">code --install-extension /path/to/jivahire-vibe-coding-interview.vsix</pre>

<h3 style="margin-top:28px;color:#111827">Step 3 &mdash; Start your interview</h3>
<ol>
  <li>After install, look at the left edge of VS Code (the <strong>Activity Bar</strong>).
      You'll see a new <strong>JivaHire</strong> icon &mdash; a small cube with a tie.
      Click it to open the JivaHire sidebar.</li>
  <li>In the JivaHire sidebar, click <strong>Start Interview</strong>, or open the
      Command Palette (<kbd>Ctrl+Shift+P</kbd> / <kbd>Cmd+Shift+P</kbd>) and run
      <em>JivaHire: Enter Session Key</em>.</li>
  <li>When prompted for the <strong>JivaHire server URL</strong>, just press
      <kbd>Enter</kbd> to accept the default
      (<code>https://interview.jivahire.com</code>). Do <strong>not</strong>
      change it unless your recruiter told you to.</li>
  <li>Paste the session key above when prompted:
      <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px">{session_key}</code></li>
  <li>Your challenge workspace will clone automatically and a new VS Code
      window will open with the code. <strong>The timer starts when the workspace opens.</strong></li>
</ol>

<p style="margin-top:28px;color:#6b7280;font-size:0.95em">Need help? Just reply to this email and we'll get back to you.</p>

<p>Good luck!<br>
&mdash; The JivaHire Team</p>
</div>
"""

    payload: dict = {
        "personalizations": [{"to": [{"email": to_email}]}],
        "from": {"email": settings.from_email, "name": "JivaHire"},
        "subject": subject,
        "content": [
            {"type": "text/plain", "value": text_body},
            {"type": "text/html", "value": html_body},
        ],
    }

    # Attach an .ics calendar invite when a start time is set. We deliberately
    # do NOT use SendGrid's "method=REQUEST" multipart shape because it
    # interacts badly with the .ics attachment dedup logic in Gmail when the
    # recruiter resends; a plain attachment is more reliable and still
    # imports correctly across Gmail, Outlook and Apple Calendar.
    if scheduled_at is not None and session_id:
        ics = _build_ics(
            session_id=session_id,
            scheduled_at=scheduled_at,
            max_minutes=max_minutes,
            challenge_id=challenge_id,
            meet_link=meet_link,
            organizer_email=settings.from_email,
            attendee_emails=[to_email],
        )
        payload["attachments"] = [
            _sendgrid_attachment(ics, "interview.ics", "text/calendar; method=REQUEST"),
        ]

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                "https://api.sendgrid.com/v3/mail/send",
                json=payload,
                headers={"Authorization": f"Bearer {settings.sendgrid_api_key}"},
            )
            if r.status_code >= 400:
                log.warning("SendGrid error %s: %s", r.status_code, r.text)
    except Exception as exc:
        log.warning("Failed to send invite email: %s", exc)


async def send_panelist_invite(
    to_email: str,
    *,
    candidate_email: str,
    challenge_id: str,
    max_minutes: int,
    meet_link: str,
    scheduled_at: int | None = None,
    session_id: str | None = None,
) -> None:
    """Send a panel-interviewer invite. Distinct from the candidate invite:
    no session key, no install steps — just the meeting link, scheduled time,
    and an .ics attachment so the panelist can RSVP via their calendar."""
    if not settings.sendgrid_api_key:
        log.info("SendGrid key not set — skipping panel invite to %s", to_email)
        return

    human_time = _format_human_time(scheduled_at) if scheduled_at is not None else None
    when_line = f"When:         {human_time}\n" if human_time else ""
    when_html = (
        f"<tr><td style=\"padding:4px 12px 4px 0;color:#6b7280\">When</td>"
        f"<td><strong>{human_time}</strong></td></tr>"
        if human_time
        else ""
    )

    subject = f"Panel interview: {candidate_email} — {challenge_id}"
    text_body = f"""Hi,

You're on the panel for a JivaHire coding interview. Join the
video call at the scheduled time; the candidate will share their
screen while they work through the challenge.

Candidate:    {candidate_email}
Challenge:    {challenge_id}
Duration:     {max_minutes} minutes
{when_line}Video call:   {meet_link}

A calendar invite (interview.ics) is attached so you can add this
to your calendar in your local timezone.

— The JivaHire Team
"""
    html_body = f"""<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;color:#111827;line-height:1.55">
<p>Hi,</p>
<p>You're on the panel for a JivaHire coding interview. Join the video
call at the scheduled time; the candidate will share their screen
while they work through the challenge.</p>

<table style="border-collapse:collapse;margin:16px 0">
  <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Candidate</td><td>{candidate_email}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Challenge</td><td>{challenge_id}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Duration</td><td>{max_minutes} minutes</td></tr>
  {when_html}
</table>

<p><a href="{meet_link}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:600">Join video call</a></p>
<p style="font-size:0.9em;color:#6b7280">Or copy this link: <a href="{meet_link}">{meet_link}</a></p>

<p style="margin-top:20px;color:#6b7280;font-size:0.9em">A calendar invite
(<code>interview.ics</code>) is attached — open it to add this to your
calendar in your local timezone.</p>

<p>&mdash; The JivaHire Team</p>
</div>
"""

    payload: dict = {
        "personalizations": [{"to": [{"email": to_email}]}],
        "from": {"email": settings.from_email, "name": "JivaHire"},
        "subject": subject,
        "content": [
            {"type": "text/plain", "value": text_body},
            {"type": "text/html", "value": html_body},
        ],
    }

    if scheduled_at is not None and session_id:
        ics = _build_ics(
            session_id=session_id,
            scheduled_at=scheduled_at,
            max_minutes=max_minutes,
            challenge_id=challenge_id,
            meet_link=meet_link,
            organizer_email=settings.from_email,
            attendee_emails=[to_email],
        )
        payload["attachments"] = [
            _sendgrid_attachment(ics, "interview.ics", "text/calendar; method=REQUEST"),
        ]

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                "https://api.sendgrid.com/v3/mail/send",
                json=payload,
                headers={"Authorization": f"Bearer {settings.sendgrid_api_key}"},
            )
            if r.status_code >= 400:
                log.warning("SendGrid error %s: %s", r.status_code, r.text)
    except Exception as exc:
        log.warning("Failed to send panelist invite: %s", exc)
