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
