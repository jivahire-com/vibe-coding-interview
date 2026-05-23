# Logging & Monitoring

Standard JSON-structured logging across the three Vibe processes. One record per line, one schema, one place to query.

## Where logs go

| Source       | Stream      | File (rotated 10 MB × 5)              | DB                  |
|--------------|-------------|---------------------------------------|---------------------|
| `server`     | stdout      | `${VIBE_LOG_DIR}/server.log`          | —                   |
| `worker`     | stdout      | `${VIBE_LOG_DIR}/worker.log`          | —                   |
| `extension`  | OutputChannel `JivaHire` | —                        | `app_logs` table    |

`VIBE_LOG_DIR` defaults to `./logs` (gitignored). The docker-compose file sets it to `/app/data/logs` so logs survive container restarts on the mounted volume.

Errors and CRITICALs from the extension are also re-emitted into the server log stream — so `grep ERROR logs/server.log` surfaces failures from both sides of a flow.

## Record shape

```json
{
  "ts": 1779514203360,
  "level": "INFO",
  "service": "server",
  "logger": "vibe.http",
  "message": "POST /api/v1/telemetry 204 7ms",
  "request_id": "a1b2c3d4e5f6",
  "session_id": "01HXYZ...",
  "context": { "method": "POST", "path": "/api/v1/telemetry", "status": 204, "duration_ms": 7 }
}
```

Fields:
- `ts` — epoch millis. Same clock domain for all sources.
- `level` — `DEBUG | INFO | WARNING | ERROR | CRITICAL`.
- `service` — which process produced it.
- `request_id` — generated per HTTP request, also returned in the `X-Request-ID` response header so a candidate-side error can be cross-referenced to a server log line.
- `session_id` — bound automatically inside grader jobs and when extension records are ingested.
- `context` — caller-supplied structured fields. Prefer `extra={"context": {...}}` over interpolating into the message string.
- `exception` — stack trace, present when the record came from `logger.exception(...)`.

## Daily monitoring recipes

```bash
# Live tail, human-readable
tail -F logs/server.log | jq -r '"\(.ts/1000|todate)  \(.level)  \(.service)  \(.message)"'

# Everything that broke in the last hour
since=$(date -d '1 hour ago' +%s)000
jq -c "select(.level==\"ERROR\" and .ts > $since)" logs/*.log

# Slow requests (>500ms)
jq -c 'select(.logger=="vibe.http" and .context.duration_ms > 500)' logs/server.log

# Trace one session end to end
jq -c 'select(.session_id=="01HXYZ...")' logs/*.log
```

## Querying client logs

The extension's logs land in the `app_logs` table. Three ways to read them:

1. **Admin HTTP endpoint** — `GET /api/v1/logs` (Bearer = `ADMIN_TOKEN`). Query params: `level`, `source`, `session_id`, `since` (epoch ms), `limit` (default 200, max 1000).
   ```bash
   curl -H "Authorization: Bearer $ADMIN_TOKEN" \
     "http://localhost:8080/api/v1/logs?level=ERROR&limit=50" | jq
   ```
2. **SQLite directly** —
   ```bash
   sqlite3 -json data/vibe.db "SELECT ts, level, message, context FROM app_logs WHERE level='ERROR' ORDER BY ts DESC LIMIT 50"
   ```
3. **Recruiter dashboard** — not wired in this PR; a follow-up can render the same query in the session detail view.

## Using the extension Logger

```ts
import { Logger } from "./logger";

const logger = new Logger(context);             // construct in activate()
context.subscriptions.push(logger);

logger.setSession(config);                       // after validateSession
logger.info("session_started", { challenge_id: config.challengeId });

try { /* ... */ }
catch (err) { logger.errorFromException("commit_failed", err, { file: rel }); }
```

The Logger buffers records, persists the buffer to `globalState` (so a crash doesn't lose them), and flushes every 10 s or at 500 records. Pre-session records keep buffering and drain when `setSession()` is called.

## Adding log calls in server / worker code

```python
import logging
log = logging.getLogger(__name__)

log.info("hidden_tests_started", extra={"context": {"challenge_id": cid, "n_tests": n}})

try: ...
except Exception:
    log.exception("hidden_tests_failed")   # auto-attaches the traceback
```

Bind `session_id` / `job_id` once at the outer boundary of a unit of work — every record nested inside picks them up automatically:

```python
from vibe.logging_config import log_context

with log_context(session_id=sid, job_id=jid):
    runner.run(sid)   # all log.* calls in here carry session_id/job_id
```

## Configuration

| Env var            | Default  | Purpose                                  |
|--------------------|----------|------------------------------------------|
| `VIBE_LOG_DIR`     | `logs`   | Directory for rotating log files.        |
| `VIBE_LOG_LEVEL`   | `INFO`   | Root level; bump to `DEBUG` for verbose. |

`urllib3`, `httpx`, `httpcore`, and `apscheduler` are pinned to `WARNING` so the dev console isn't drowned in noise. Lift their levels individually in code if you need wire-level traces.
