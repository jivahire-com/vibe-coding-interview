import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

_tls = threading.local()


def _conn() -> sqlite3.Connection:
    if not hasattr(_tls, "conn"):
        from vibe.config import settings
        conn = sqlite3.connect(settings.db_path, check_same_thread=False, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        _tls.conn = conn
    return _tls.conn


def query(sql: str, params=()) -> list[dict]:
    return [dict(r) for r in _conn().execute(sql, params).fetchall()]


def execute(sql: str, params=()) -> sqlite3.Cursor:
    return _conn().execute(sql, params)


def executemany(sql: str, params_seq) -> None:
    _conn().executemany(sql, params_seq)


@contextmanager
def immediate_transaction():
    conn = _conn()
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def bootstrap() -> None:
    schema = Path(__file__).parent / "schema.sql"
    _conn().executescript(schema.read_text())
    _migrate()


def _migrate() -> None:
    """Idempotent ALTER TABLE migrations for columns added after initial schema."""
    migrations = [
        ("sessions", "typed_chars", "INTEGER NOT NULL DEFAULT 0"),
        ("sessions", "pasted_chars", "INTEGER NOT NULL DEFAULT 0"),
        ("sessions", "ai_applied_chars", "INTEGER NOT NULL DEFAULT 0"),
        ("sessions", "meet_link", "TEXT"),
        ("sessions", "video_platform", "TEXT NOT NULL DEFAULT 'google_meet'"),
        ("sessions", "scheduled_at", "INTEGER"),
        ("sessions", "panelist_emails", "TEXT"),
        ("sessions", "video_s3_key", "TEXT"),
        ("sessions", "video_uploaded_at", "INTEGER"),
        ("sessions", "video_duration_seconds", "INTEGER"),
        ("sessions", "require_end_video", "INTEGER NOT NULL DEFAULT 0"),
        # 1 ⇒ AI chat enabled (default); 0 ⇒ normal coding (no AI). INTEGER 0/1
        # to match the existing boolean-flag convention in this table.
        ("sessions", "ai_assistance", "INTEGER NOT NULL DEFAULT 1"),
        ("sessions", "source_ref", "TEXT NOT NULL DEFAULT 'main'"),
        # Tenant tag supplied by the recruiter-backend proxy so admin queries can
        # be scoped to a single organization. NULL on legacy/direct sessions.
        ("sessions", "org_id", "TEXT"),
        ("chat_exchanges", "cached_input_tokens", "INTEGER NOT NULL DEFAULT 0"),
        ("chat_exchanges", "reasoning_tokens", "INTEGER NOT NULL DEFAULT 0"),
        ("chat_exchanges", "prompt_text", "TEXT"),
        ("chat_exchanges", "prompt_classification", "TEXT"),
        ("chat_exchanges", "prompt_score", "INTEGER"),
        ("chat_exchanges", "prompt_reasoning", "TEXT"),
        ("chat_exchanges", "candidate_prompt_tokens", "INTEGER"),
        ("chat_exchanges", "prompt_level", "INTEGER"),
        ("chat_exchanges", "applied", "INTEGER NOT NULL DEFAULT 0"),
        ("chat_exchanges", "correction_of", "INTEGER REFERENCES chat_exchanges(id)"),
        ("grades", "prompt_quality_score", "INTEGER"),
        ("grades", "developer_confidence_score", "INTEGER"),
        ("grades", "developer_confidence_verdict", "TEXT"),
        ("grades", "developer_confidence_signals", "TEXT"),
        ("grades", "developer_confidence_reasoning", "TEXT"),
        ("grades", "code_quality_breakdown", "TEXT"),
        ("grades", "architectural_reasoning_breakdown", "TEXT"),
        ("grades", "llm_communication_score", "REAL"),
        ("grades", "llm_communication_breakdown", "TEXT"),
        ("grades", "verification_discipline_score", "REAL"),
        ("grades", "verification_discipline_breakdown", "TEXT"),
        ("grades", "ai_judgment_score", "REAL"),
        ("grades", "ai_judgment_breakdown", "TEXT"),
        ("grades", "challenge_specific_score", "REAL"),
        ("grades", "challenge_specific_breakdown", "TEXT"),
        ("grades", "trap_attribution", "TEXT"),
        ("grades", "composite_breakdown", "TEXT"),
        # Three-layer rework (GRADING_METRICS_MAP.md): the grade is now one
        # structured report. These columns carry it on pre-existing `grades`
        # tables; fresh DBs get them from schema.sql. Legacy per-dimension
        # columns above are left in place but no longer written.
        ("grades", "track", "TEXT"),
        ("grades", "band", "TEXT"),
        ("grades", "report_json", "TEXT"),
    ]
    conn = _conn()
    for table, column, col_def in migrations:
        try:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_def}")
        except Exception:
            pass  # column already exists

    # Column drops (SQLite ≥ 3.35). Silently skip if column is already gone.
    drops = [
        ("grades", "token_efficiency_score"),
    ]
    for table, column in drops:
        try:
            conn.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
        except Exception:
            pass  # column already absent

    # Indexes for columns added above. IF NOT EXISTS keeps this idempotent.
    try:
        conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_org_id ON sessions(org_id)")
    except Exception:
        pass
