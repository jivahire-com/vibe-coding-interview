import logging
import httpx
from vibe.config import settings

log = logging.getLogger(__name__)


async def send_invite(
    to_email: str,
    session_key: str,
    challenge_id: str,
    max_minutes: int,
    budget_usd: float,
) -> None:
    if not settings.sendgrid_api_key:
        log.info("SendGrid key not set — skipping invite email to %s", to_email)
        return

    subject = "Your JivaHire Coding Interview Invitation"
    text_body = f"""Hi,

You've been invited to complete a coding interview on the JivaHire platform.

Session Key: {session_key}
Challenge: {challenge_id}
Time Limit: {max_minutes} minutes
AI Budget: ${budget_usd:.2f}

To get started:
1. Install VS Code (https://code.visualstudio.com) if you haven't already
2. Download and install the JivaHire extension (.vsix) from:
   {settings.app_public_url}/jivahire-vibe-coding-interview.vsix
3. Open VS Code → press Ctrl+Shift+P → "JivaHire: Enter Session Key"
4. Enter the session key above when prompted
5. Your challenge workspace will clone automatically

Good luck!

— The JivaHire Team
"""
    html_body = f"""<p>Hi,</p>
<p>You've been invited to complete a coding interview on the <strong>JivaHire</strong> platform.</p>
<table style="border-collapse:collapse;margin:16px 0">
  <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Session Key</td>
      <td><code style="background:#f3f4f6;padding:4px 8px;border-radius:4px;font-size:1.1em">{session_key}</code></td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Challenge</td><td>{challenge_id}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Time Limit</td><td>{max_minutes} minutes</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#6b7280">AI Budget</td><td>${budget_usd:.2f}</td></tr>
</table>
<p><strong>To get started:</strong></p>
<ol>
  <li>Install <a href="https://code.visualstudio.com">VS Code</a> if you haven't already</li>
  <li>Download and install the JivaHire extension (.vsix) from:<br>
      <a href="{settings.app_public_url}/jivahire-vibe-coding-interview.vsix">{settings.app_public_url}/jivahire-vibe-coding-interview.vsix</a></li>
  <li>Open VS Code → press <kbd>Ctrl+Shift+P</kbd> → <em>JivaHire: Enter Session Key</em></li>
  <li>Enter the session key above when prompted</li>
  <li>Your challenge workspace will clone automatically</li>
</ol>
<p>Good luck!</p>
<p>— The JivaHire Team</p>
"""

    payload = {
        "personalizations": [{"to": [{"email": to_email}]}],
        "from": {"email": settings.from_email, "name": "JivaHire"},
        "subject": subject,
        "content": [
            {"type": "text/plain", "value": text_body},
            {"type": "text/html", "value": html_body},
        ],
    }

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
