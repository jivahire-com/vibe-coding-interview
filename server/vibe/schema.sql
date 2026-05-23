PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    session_key TEXT UNIQUE NOT NULL,
    candidate_email TEXT NOT NULL,
    challenge_id TEXT NOT NULL,
    branch_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    llm_budget_usd REAL NOT NULL DEFAULT 2.00,
    llm_spent_usd REAL NOT NULL DEFAULT 0.0,
    max_minutes INTEGER NOT NULL DEFAULT 90,
    started_at INTEGER,
    submitted_at INTEGER,
    meet_link TEXT,
    video_platform TEXT NOT NULL DEFAULT 'google_meet',
    scheduled_at INTEGER,
    panelist_emails TEXT,
    typed_chars INTEGER NOT NULL DEFAULT 0,
    pasted_chars INTEGER NOT NULL DEFAULT 0,
    ai_applied_chars INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_key ON sessions(session_key);
CREATE INDEX IF NOT EXISTS idx_sessions_status_started ON sessions(status, started_at);

CREATE TABLE IF NOT EXISTS telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    ts INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telemetry_session_ts ON telemetry(session_id, ts);

CREATE TABLE IF NOT EXISTS chat_exchanges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    ts INTEGER NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    aborted_over_budget INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    prompt_text TEXT,
    prompt_classification TEXT,
    prompt_level INTEGER,
    applied INTEGER NOT NULL DEFAULT 0,
    correction_of INTEGER REFERENCES chat_exchanges(id)
);
CREATE INDEX IF NOT EXISTS idx_chat_session_ts ON chat_exchanges(session_id, ts);

CREATE TABLE IF NOT EXISTS grades (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id),
    tests_passed INTEGER,
    tests_total INTEGER,
    traps_detected INTEGER,
    traps_total INTEGER,
    code_quality_score REAL,
    code_quality_breakdown TEXT,
    architectural_reasoning_score REAL,
    architectural_reasoning_breakdown TEXT,
    llm_communication_score REAL,
    llm_communication_breakdown TEXT,
    verification_discipline_score REAL,
    verification_discipline_breakdown TEXT,
    ai_judgment_score REAL,
    ai_judgment_breakdown TEXT,
    challenge_specific_score REAL,
    challenge_specific_breakdown TEXT,
    trap_attribution TEXT,
    composite_breakdown TEXT,
    total_score REAL,
    grader_summary TEXT,
    raw_output TEXT,
    graded_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    started_at INTEGER,
    finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_pending ON jobs(status, created_at);

CREATE TABLE IF NOT EXISTS grading_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    ts INTEGER NOT NULL,
    user_message TEXT NOT NULL,
    stage TEXT NOT NULL,
    error_class TEXT,
    traceback TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grading_errors_session ON grading_errors(session_id, ts);

CREATE TABLE IF NOT EXISTS video_upload_tokens (
    token_hash TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_video_tokens_session ON video_upload_tokens(session_id);

CREATE TABLE IF NOT EXISTS app_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,             -- epoch millis (matches client clock)
    source TEXT NOT NULL,            -- 'extension' | 'server' | 'worker' | 'grader'
    level TEXT NOT NULL,             -- DEBUG / INFO / WARNING / ERROR / CRITICAL
    logger TEXT,                     -- e.g. 'vibe.http', 'extension.chat'
    message TEXT NOT NULL,
    session_id TEXT REFERENCES sessions(id),
    context TEXT                     -- JSON-encoded extra fields
);
CREATE INDEX IF NOT EXISTS idx_app_logs_session_ts ON app_logs(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_app_logs_level_ts ON app_logs(level, ts);
