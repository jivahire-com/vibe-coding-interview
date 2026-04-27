import time
from vibe.db import immediate_transaction, execute, query


def enqueue(session_id: str) -> None:
    execute(
        "INSERT INTO jobs (kind, session_id) VALUES ('grade', ?)",
        (session_id,),
    )


def claim_job() -> dict | None:
    try:
        with immediate_transaction() as conn:
            row = conn.execute(
                "UPDATE jobs SET status='running', started_at=?, attempts=attempts+1 "
                "WHERE id=(SELECT id FROM jobs WHERE status='pending' ORDER BY id LIMIT 1) "
                "RETURNING id, session_id, attempts",
                (int(time.time()),),
            ).fetchone()
        return dict(row) if row else None
    except Exception:
        return None


def complete_job(job_id: int) -> None:
    execute(
        "UPDATE jobs SET status='done', finished_at=? WHERE id=?",
        (int(time.time()), job_id),
    )


def fail_job(job_id: int, error: str, attempts: int) -> None:
    if attempts >= 3:
        execute(
            "UPDATE jobs SET status='failed', finished_at=?, last_error=? WHERE id=?",
            (int(time.time()), error[:1000], job_id),
        )
    else:
        execute(
            "UPDATE jobs SET status='pending', last_error=? WHERE id=?",
            (error[:1000], job_id),
        )
