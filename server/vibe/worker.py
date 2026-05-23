import logging
import os
import time
from apscheduler.schedulers.blocking import BlockingScheduler
from vibe.db import bootstrap, execute, immediate_transaction, query
from vibe.jobs import claim_job, complete_job, fail_job
from vibe.grader import runner
from vibe.logging_config import configure_logging, log_context

configure_logging("worker")
logger = logging.getLogger(__name__)

# Default 30 days — large enough to debug a week-old grading mishap, small
# enough that a chatty extension on a long-running server doesn't fill the
# disk. Override with VIBE_LOG_RETENTION_DAYS.
RETENTION_DAYS = int(os.environ.get("VIBE_LOG_RETENTION_DAYS", "30"))

sched = BlockingScheduler()


@sched.scheduled_job("interval", seconds=120, id="auto_submit_sweep")
def auto_submit_sweep() -> None:
    now = int(time.time())
    try:
        with immediate_transaction() as conn:
            expired = conn.execute(
                "SELECT id FROM sessions "
                "WHERE status='active' AND started_at + max_minutes*60 < ?",
                (now,),
            ).fetchall()
            if not expired:
                return
            ids = [r["id"] for r in expired]
            conn.execute(
                f"UPDATE sessions SET status='submitted', submitted_at=? "
                f"WHERE id IN ({','.join('?'*len(ids))})",
                [now, *ids],
            )
            existing = {
                r["session_id"]
                for r in conn.execute(
                    f"SELECT session_id FROM jobs WHERE kind='grade' "
                    f"AND session_id IN ({','.join('?'*len(ids))})",
                    ids,
                ).fetchall()
            }
            for sid in ids:
                if sid not in existing:
                    conn.execute(
                        "INSERT INTO jobs (kind, session_id) VALUES ('grade', ?)", (sid,)
                    )
        logger.info("auto_submit_sweep: expired %d session(s)", len(ids))
    except Exception as e:
        logger.error("auto_submit_sweep error: %s", e)


@sched.scheduled_job("interval", seconds=10, id="drain_grade_queue")
def drain_grade_queue() -> None:
    job = claim_job()
    if not job:
        return
    with log_context(session_id=job["session_id"], job_id=str(job["id"])):
        logger.info("grading session %s (job %s, attempt %d)", job["session_id"], job["id"], job["attempts"])
        try:
            runner.run(job["session_id"])
            complete_job(job["id"])
            logger.info("graded session %s OK", job["session_id"])
        except Exception as e:
            fail_job(job["id"], str(e), job["attempts"])
            logger.exception("grading session %s failed: %s", job["session_id"], e)


@sched.scheduled_job("interval", hours=6, id="app_logs_retention")
def app_logs_retention() -> None:
    """Delete app_logs records older than RETENTION_DAYS so the SQLite file
    doesn't grow unbounded. Runs every 6 hours; the first sweep happens 6h
    after worker boot, which is fine — the table starts empty and there is
    no urgency to delete records that haven't been written yet."""
    cutoff_ms = int((time.time() - RETENTION_DAYS * 86400) * 1000)
    try:
        with immediate_transaction() as conn:
            cur = conn.execute("DELETE FROM app_logs WHERE ts < ?", (cutoff_ms,))
            n = cur.rowcount
        if n:
            logger.info(
                "app_logs_retention deleted %d record(s) older than %d days",
                n, RETENTION_DAYS,
                extra={"context": {"deleted": n, "retention_days": RETENTION_DAYS}},
            )
    except Exception:
        logger.exception("app_logs_retention failed")


if __name__ == "__main__":
    bootstrap()
    logger.info("worker starting", extra={"context": {"retention_days": RETENTION_DAYS}})
    sched.start()
