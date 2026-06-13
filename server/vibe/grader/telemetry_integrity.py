"""
Telemetry-file integrity check (tamper detection for `.jivahire/telemetry.jsonl`).

The extension writes one event per line to `.jivahire/telemetry.jsonl` and, on
the very first event of a session, reports an immutable *anchor* — the `ts` and
`id` of that first event — to the server via `POST /api/v1/logs`. The anchor
lands in `app_logs` (Bearer-authed, candidate cannot read or alter it). At grade
time we compare that recorded anchor against the first line of the
`telemetry.jsonl` actually committed to the candidate's branch:

    anchor recorded, file MISSING          → "deleted"   (tamper)
    anchor recorded, file present but empty → "emptied"   (tamper)
    anchor recorded, first event ≠ anchor  → "recreated" (tamper)
    anchor recorded, first event == anchor → "ok"
    no anchor recorded                      → "unknown"   (fail open, no penalty)

Why this works: deleting the file does not erase the evidence. The extension
recreates it on its next event with a brand-new first-event `id` and a later
`ts`, so the recorded anchor no longer matches. A candidate cannot forge a match
without the original `id`, which is server-held and never exposed to them.

The check fails open everywhere it is uncertain (no anchor, grader/DB error):
an integrity penalty is only ever applied to a *provable* deletion, never to a
candidate on the strength of a missing or ambiguous data source.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from vibe.db import query

log = logging.getLogger("vibe.grader")

_JSONL_PATH = Path(".jivahire") / "telemetry.jsonl"
_ANCHOR_MESSAGE = "telemetry_anchor"


def check(session_id: str, clone_dir: Path) -> dict[str, Any]:
    """Return the integrity verdict for a session's telemetry file.

    Shape: {"tampered": bool, "verdict": str, "detail": str,
            "anchor": {ts, id}|None, "found": {ts, id}|None}.
    """
    anchor = _recorded_anchor(session_id)
    if anchor is None:
        # No server-side record of a first event — old/offline extension, or a
        # genuine no-show. Nothing to compare against; never penalize.
        return _verdict(False, "unknown",
                        "No telemetry anchor was recorded server-side; "
                        "integrity could not be checked.",
                        anchor=None, found=None)

    jsonl_file = clone_dir / _JSONL_PATH
    if not jsonl_file.exists():
        return _verdict(True, "deleted",
                        "A telemetry first-event was recorded server-side, but "
                        ".jivahire/telemetry.jsonl is absent from the submitted "
                        "branch — the file was deleted.",
                        anchor=anchor, found=None)

    found = _file_first_event(jsonl_file)
    if found is None:
        return _verdict(True, "emptied",
                        ".jivahire/telemetry.jsonl is present but has no valid "
                        "first event, while one was recorded server-side — the "
                        "file was emptied or truncated.",
                        anchor=anchor, found=None)

    if found["id"] != anchor["id"] or found["ts"] != anchor["ts"]:
        return _verdict(True, "recreated",
                        f"First telemetry event on the branch (id={found['id']}, "
                        f"ts={found['ts']}) does not match the session anchor "
                        f"recorded server-side (id={anchor['id']}, "
                        f"ts={anchor['ts']}) — the file was deleted and recreated "
                        "mid-session, discarding the original event history.",
                        anchor=anchor, found=found)

    return _verdict(False, "ok",
                    "Telemetry first-event matches the recorded session anchor.",
                    anchor=anchor, found=found)


def _verdict(tampered: bool, verdict: str, detail: str, *,
             anchor: dict | None, found: dict | None) -> dict[str, Any]:
    return {"tampered": tampered, "verdict": verdict, "detail": detail,
            "anchor": anchor, "found": found}


def _recorded_anchor(session_id: str) -> dict[str, Any] | None:
    """The earliest `telemetry_anchor` recorded for the session, as {ts, id}.

    The extension may report the anchor more than once (it re-reports on every
    activation of a resumed session); they all carry the same first-event
    values, but we take the earliest-`ts` record defensively.
    """
    rows = query(
        "SELECT context FROM app_logs "
        "WHERE session_id=? AND source='extension' AND message=? "
        "ORDER BY ts ASC LIMIT 1",
        (session_id, _ANCHOR_MESSAGE),
    )
    if not rows:
        return None
    raw = rows[0].get("context")
    if not raw:
        return None
    try:
        ctx = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None
    ts, fid = ctx.get("first_ts"), ctx.get("first_id")
    if not isinstance(ts, int) or not isinstance(fid, str):
        return None
    return {"ts": ts, "id": fid}


def _file_first_event(jsonl_file: Path) -> dict[str, Any] | None:
    """Parse the first valid event line of the JSONL file, or None."""
    try:
        with jsonl_file.open() as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                evt = json.loads(raw)
                ts, eid = evt.get("ts"), evt.get("id")
                if isinstance(ts, int) and isinstance(eid, str):
                    return {"ts": ts, "id": eid}
                return None  # first non-blank line isn't a valid event
    except (OSError, json.JSONDecodeError):
        return None
    return None
