import logging
import time
from apscheduler.schedulers.blocking import BlockingScheduler
from vibe.db import bootstrap, execute, immediate_transaction, query
from vibe.jobs import claim_job, complete_job, fail_job
from vibe.grader import runner
from vibe.logging_config import configure_logging, log_context

configure_logging("worker")
logger = logging.getLogger(__name__)

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


if __name__ == "__main__":
    bootstrap()
    logger.info("worker starting")
    sched.start()
