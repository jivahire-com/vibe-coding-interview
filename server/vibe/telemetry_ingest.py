"""
Shared telemetry ingest helper.

apply_events() is called by the grader after reading .jivahire/telemetry.jsonl
from the cloned candidate repo. It writes to the same `telemetry` table and
session char-counter columns that the old POST /api/v1/telemetry route used,
so all downstream grader consumers and the dashboard work unchanged.
"""
import json
from typing import Any

from vibe.db import execute, executemany, immediate_transaction

_CHAR_COUNTER_EVENTS = {
    "edit_typed": "typed_chars",
    "edit_pasted": "pasted_chars",
    "edit_ai_applied": "ai_applied_chars",
}


def apply_events(session_id: str, events: list[dict[str, Any]]) -> None:
    """Insert *events* into the telemetry table and update session char counters.

    Each event must have keys: ts (int), event_type (str), payload (dict).
    Already called inside a transaction by the grader's _ingest_telemetry_jsonl;
    safe to call stand-alone too.
    """
    if not events:
        return
    executemany(
        "INSERT INTO telemetry (session_id, ts, event_type, payload) VALUES (?, ?, ?, ?)",
        [(session_id, e["ts"], e["event_type"], json.dumps(e.get("payload", {}))) for e in events],
    )
    typed = pasted = ai_applied = 0
    for e in events:
        col = _CHAR_COUNTER_EVENTS.get(e["event_type"])
        if col:
            chars = (e.get("payload") or {}).get("chars", 0) or 0
            if col == "typed_chars":
                typed += chars
            elif col == "pasted_chars":
                pasted += chars
            elif col == "ai_applied_chars":
                ai_applied += chars
    if typed or pasted or ai_applied:
        execute(
            "UPDATE sessions SET typed_chars = typed_chars + ?, "
            "pasted_chars = pasted_chars + ?, "
            "ai_applied_chars = ai_applied_chars + ? WHERE id=?",
            (typed, pasted, ai_applied, session_id),
        )
