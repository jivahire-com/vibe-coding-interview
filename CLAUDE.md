# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

This repository currently contains a single specification document: `vibe_interview_plan.md`. No code has been written yet. All architecture, commands, and module descriptions below are derived from that plan and represent the intended implementation.

## What Is Being Built

**Vibe** is an AI-aware coding interview platform consisting of:

1. **VS Code Extension** (TypeScript) — installs on the candidate's machine; handles session auth, challenge workspace setup, AI chat proxying, telemetry collection, auto-commits, and a countdown timer.
2. **Django Backend** (Python) — manages interview sessions, ingests telemetry, triggers async grading, and serves recruiter dashboards.
3. **LLM Proxy** (`server/vibe/llm_proxy.py`) — proxies candidate chat to the configured model via OpenRouter, enforces per-session token budgets in-process against SQLite (`sessions.llm_spent_usd` vs `llm_budget_usd`).
4. **Challenge Repos** — private GitHub repos, one per challenge; candidate gets an isolated `interview/<session_id>` branch.

## Extension: Build Commands

Once `package.json` and source files exist under `extension/`:

```bash
npm run build      # esbuild bundles src/extension.ts → dist/extension.js
npm run watch      # watch mode for development
npm run lint       # tsc --noEmit (type checking only, no emit)
npm run package    # vsce package --no-dependencies → .vsix file
```

esbuild config: bundles all local imports, externalizes `vscode`, outputs CommonJS to `dist/extension.js` with sourcemaps.

## Backend: Setup and Commands

Once the Django app exists under `backend/`:

```bash
python manage.py startapp interviews       # create the interviews app
python manage.py migrate                   # apply interview_sessions/telemetry/grades tables
celery -A jivahire worker -l info          # start grading worker
celery -A jivahire beat -l info            # start auto-submit cron (every 10 min)
```

Key environment variables needed: `OPENAI_API_KEY`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `DATABASE_URL`, `REDIS_URL`.

## Architecture

### Extension State Machine

The extension lifecycle is a strict 6-state machine — always implement state transitions explicitly, never implicitly:

```
IDLE → AUTHENTICATING → CLONING → ACTIVE → SUBMITTING → DONE
                          ↓           ↓
                        IDLE        IDLE
```

Session state persists to VS Code `globalState` so the extension can resume after a crash.

### Telemetry Pipeline

```
Candidate action (edit/paste/chat)
  → TelemetryTracker classifies event (typed / pasted / ai-assisted)
  → TelemetryBuffer (local VS Code globalState, offline-safe)
    → flushed every 10s or at 500 events → POST /api/v1/interviews/telemetry
```

Never flush synchronously on the hot path — buffer first, flush async.

### Auto-Commit Audit Trail

Every 3 minutes: `git add -A && git commit -m "auto: <timestamp>" && git push`. The `.jivahire_chat_log.json` file (append-only JSON array of chat exchanges) is committed alongside code changes. This creates a tamper-evident timeline the grader parses — do not change commit message format without updating the grader's parser.

### Grading Pipeline (Celery)

Triggered by `POST /submit` or by the auto-submit worker on session expiry:

1. Clone candidate's `interview/<session_id>` branch
2. Run hidden tests (automated pass/fail scoring)
3. Check traps (embedded security/quality issues in the challenge)
4. 3-stage LLM evaluation: **code quality** → **AI orchestration** → **architectural reasoning**
5. Composite weighted score → saved to `InterviewGrade`

Each LLM evaluation uses a focused rubric and returns structured JSON — never a single "score this 1-10" prompt.

### API Endpoints

```
POST /api/v1/interviews/sessions              # recruiter creates session
POST /api/v1/interviews/validate-session      # extension authenticates candidate
POST /api/v1/interviews/telemetry             # extension buffers flush
POST /api/v1/interviews/submit                # final submission
GET  /api/v1/interviews/sessions/:id          # recruiter view
GET  /api/v1/interviews/sessions/:id/timeline # commit replay view
```

### Key Data Models

- `InterviewSession` — session key, candidate info, challenge assignment, state, expiry, GitHub token
- `InterviewTelemetry` — event_type, payload JSON, timestamp, session FK
- `InterviewGrade` — composite score, per-dimension subscores, structured LLM reasoning, grading metadata

## Karpathy Guidelines

These apply whenever writing code in this repo:

**Think before coding.** State assumptions explicitly. If multiple interpretations exist, surface them — don't pick silently. Ask when unclear.

**Simplicity first.** Minimum code that solves the problem. No speculative features, no abstractions for single-use code, no error handling for impossible scenarios. If a solution exceeds ~200 lines and could be 50, rewrite it.

**Surgical changes.** Touch only what the task requires. Don't "improve" adjacent code, comments, or formatting. Every changed line should trace directly to the request.

**Goal-driven execution.** Transform tasks into verifiable criteria before implementing. For multi-step work, write the plan with explicit verification steps before writing code.

## Privacy and Security Constraints

- Candidate prompt history lives only in the git branch (`.jivahire_chat_log.json`) — it is deleted when the branch is deleted. Never persist it in the DB.
- Session keys must be rate-limited (5 attempts/IP/hour) before any DB lookup.
- The `.jivahire/` directory in challenge repos (rubric, traps, hidden tests) must be stripped before creating the candidate branch — verify this in branch-creation logic.
- GitHub tokens are short-lived installation tokens (~1 hour); never store long-lived PATs.
- Per-session LLM budget ($2.00 default) is enforced by `llm_proxy.py` against `sessions.llm_spent_usd` — the extension should respect 402 responses from `POST /api/v1/llm/chat/completions`.
