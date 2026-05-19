"""Public listing of currently-available challenges.

Renders a simple HTML page at GET /challenges. Data is read from the
filesystem at request time so adding a new challenge directory under
challenges/ is enough — no code change required.

Only candidate-safe fields are exposed: the title (from metadata.json)
and a short task description (from rubric.json). Trap definitions,
hidden tests, and the rest of the .jivahire/ contents are never sent.
"""

import html
import json
import os

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from vibe.config import settings

router = APIRouter()


def _load_challenges() -> list[dict]:
    challenges_path = settings.challenges_dir
    try:
        entries = sorted(
            d for d in os.listdir(challenges_path)
            if os.path.isdir(os.path.join(challenges_path, d)) and not d.startswith(".")
        )
    except FileNotFoundError:
        return []

    items: list[dict] = []
    for cid in entries:
        meta = _safe_read_json(os.path.join(challenges_path, cid, ".jivahire", "metadata.json"))
        if meta.get("status") == "draft":
            continue
        rubric = _safe_read_json(os.path.join(challenges_path, cid, ".jivahire", "rubric.json"))
        items.append({
            "id": cid,
            "title": meta.get("title") or cid,
            "description": rubric.get("description") or cid,
        })
    return items


def _safe_read_json(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Available Challenges - JivaHire Vibe</title>
<link rel="stylesheet" href="/style.css" />
<script>
  (function () {{
    var saved = localStorage.getItem('jh_theme');
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', saved || (prefersDark ? 'dark' : 'light'));
  }})();
</script>
<style>
  .challenges-wrap {{ max-width: 760px; margin: 40px auto; padding: 0 20px; line-height: 1.5; }}
  .challenges-wrap h1 {{ font-size: 24px; margin: 0 0 8px; color: var(--text); }}
  .lead {{ color: var(--text-muted); margin: 0 0 24px; font-size: 14px; }}
  .challenge {{ padding: 16px 0; border-bottom: 1px solid var(--border); }}
  .challenge:last-child {{ border-bottom: none; }}
  .title {{ font-size: 17px; font-weight: 600; margin: 0 0 4px; color: var(--text); }}
  .cid {{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 12px; color: var(--text-xmuted); margin-left: 8px; font-weight: 400; }}
  .desc {{ margin: 0; color: var(--text); font-size: 14px; opacity: 0.85; }}
  .empty {{ color: var(--text-muted); font-style: italic; padding: 24px 0; }}
</style>
</head>
<body>
  <nav class="nav">
    <div class="nav-logo">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
      </svg>
      JivaHire <span>Challenges</span>
    </div>
    <div class="ml-auto flex items-center gap-2">
      <button id="theme-toggle" class="btn btn-ghost btn-sm" type="button"
              onclick="(function(){{var t=document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';document.documentElement.setAttribute('data-theme',t);localStorage.setItem('jh_theme',t);document.getElementById('icon-sun').style.display=t==='dark'?'inline':'none';document.getElementById('icon-moon').style.display=t==='dark'?'none':'inline';}})()">
        <svg id="icon-sun" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
        <svg id="icon-moon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      </button>
      <a class="btn btn-ghost btn-sm" href="/">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        Back to Dashboard
      </a>
    </div>
  </nav>
  <script>
    (function(){{
      var t = document.documentElement.getAttribute('data-theme');
      document.getElementById('icon-sun').style.display = t === 'dark' ? 'inline' : 'none';
      document.getElementById('icon-moon').style.display = t === 'dark' ? 'none' : 'inline';
    }})();
  </script>
  <div class="challenges-wrap">
    <h1>Available Challenges</h1>
    <p class="lead">Currently-available coding interview challenges.</p>
    {body}
  </div>
</body>
</html>
"""


@router.get("/challenges", response_class=HTMLResponse, include_in_schema=False)
def challenges_page() -> HTMLResponse:
    items = _load_challenges()
    if not items:
        body = '<p class="empty">No challenges available.</p>'
    else:
        rows = []
        for c in items:
            rows.append(
                '<div class="challenge">'
                f'<p class="title">{html.escape(c["title"])}'
                f'<span class="cid">{html.escape(c["id"])}</span></p>'
                f'<p class="desc">{html.escape(c["description"])}</p>'
                '</div>'
            )
        body = "\n".join(rows)
    return HTMLResponse(_PAGE.format(body=body))
