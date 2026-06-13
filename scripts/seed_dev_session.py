#!/usr/bin/env python3
"""Create a dev session for local testing. Prints the session key."""
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "server"))
from vibe.db import bootstrap, execute, query

bootstrap()

SESSION_KEY = "DEV-001"
existing = query("SELECT id FROM sessions WHERE session_key=?", (SESSION_KEY,))
if existing:
    print(f"Session already exists: SESSION_KEY={SESSION_KEY}")
    sys.exit(0)

session_id = uuid.uuid4().hex
branch = f"interview/{session_id}"
execute(
    "INSERT INTO sessions "
    "(id, session_key, candidate_email, challenge_id, branch_name, llm_budget_usd, max_minutes) "
    "VALUES (?, ?, ?, ?, ?, ?, ?)",
    (session_id, SESSION_KEY, "dev@example.com", "cpp-thread-safe-cache", branch, 2.00, 60),
)
print(f"Created dev session.")
print(f"  SESSION_KEY={SESSION_KEY}")
print(f"  session_id={session_id}")
print(f"  branch={branch}")
print(f"\nActivate with: POST /api/v1/validate-session {{\"session_key\": \"{SESSION_KEY}\"}}")
