"""
Grader-side JSONL ingest: reads .jivahire/telemetry.jsonl from the cloned
candidate repo and populates the telemetry table + session counters.

Called by runner.run() between the clone step and the build step so all five
downstream grader consumers see the rows in the DB.
"""
import json
import logging
from pathlib import Path

from vibe.db import execute, immediate_transaction
from vibe.telemetry_ingest import apply_events

log = logging.getLogger("vibe.grader")

_JSONL_PATH = Path(".jivahire") / "telemetry.jsonl"


def ingest(session_id: str, clone_dir: Path) -> None:
    """Idempotent: wipes and re-inserts telemetry rows from the JSONL file.

    Missing file is silently OK (old extension version or offline candidate).
    Malformed lines are skipped with a warning; one bad line never aborts.
    """
    jsonl_file = clone_dir / _JSONL_PATH
    if not jsonl_file.exists():
        log.info(
            "telemetry_jsonl_missing",
            extra={"context": {"session_id": session_id}},
        )
        return

    events: list[dict] = []
    with jsonl_file.open() as fh:
        for lineno, raw in enumerate(fh, 1):
            raw = raw.strip()
            if not raw:
                continue
            try:
                evt = json.loads(raw)
            except json.JSONDecodeError as exc:
                log.warning(
                    "telemetry_jsonl_bad_line",
                    extra={"context": {"session_id": session_id, "lineno": lineno, "error": str(exc)}},
                )
                continue
            events.append(evt)

    # Idempotency: clear prior rows (including any from an old-extension POST)
    # before re-inserting so re-grades don't double-count.
    with immediate_transaction():
        execute("DELETE FROM telemetry WHERE session_id=?", (session_id,))
        execute(
            "UPDATE sessions SET typed_chars=0, pasted_chars=0, ai_applied_chars=0 WHERE id=?",
            (session_id,),
        )
        apply_events(session_id, events)

    log.info(
        "telemetry_jsonl_ingested",
        extra={"context": {"session_id": session_id, "events": len(events)}},
    )
