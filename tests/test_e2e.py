import os
import tempfile
import threading

import pytest
import respx
from httpx import ASGITransport, AsyncClient, Response

# env must be set before vibe imports so pydantic-settings reads them
_db_fd, _db_path = tempfile.mkstemp(suffix=".db")
os.environ.update({
    "OPENAI_API_KEY": "sk-test",
    "GITHUB_CHALLENGES_REPO": "test-org/test-repo",
    "GITHUB_CHALLENGES_OWNER": "",
    "ADMIN_TOKEN": "admin-secret",
    "DB_PATH": _db_path,
    "LLM_BASE_URL": "https://openrouter.ai/api/v1",
})
# GitHub App env + mint stub are set in tests/conftest.py.

from vibe.main import app  # noqa: E402
from vibe.db import bootstrap, execute, query  # noqa: E402
import vibe.auth as _auth  # noqa: E402

bootstrap()

_REPO = "test-org/test-repo"
_ADMIN = {"X-Admin-Token": "admin-secret"}
_GH_REF = f"https://api.github.com/repos/{_REPO}/git/ref/heads/main"
_GH_REFS = f"https://api.github.com/repos/{_REPO}/git/refs"


@pytest.fixture(autouse=True)
def _clean():
    _auth._rate_limits.clear()
    for tbl in ("grading_errors", "grades", "jobs", "chat_exchanges", "telemetry", "sessions"):
        execute(f"DELETE FROM {tbl}")
    yield


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def _mock_github():
    respx.get(_GH_REF).mock(return_value=Response(200, json={"object": {"sha": "abc123"}}))
    respx.post(_GH_REFS).mock(return_value=Response(201))


async def _create_session(client, key: str) -> str:
    r = await client.post(
        "/api/v1/sessions",
        json={"session_key": key, "candidate_email": "c@test.com", "challenge_id": "cpp-thread-safe-cache"},
        headers=_ADMIN,
    )
    assert r.status_code == 201
    return r.json()["session_id"]


@pytest.fixture
async def active_session(client):
    with respx.mock:
        _mock_github()
        sid = await _create_session(client, "TEST-001")
        await client.post("/api/v1/validate-session", json={"session_key": "TEST-001"})
    return "TEST-001", sid


# ── tests ────────────────────────────────────────────────────────────────────

async def test_rate_limit_validate_session(client):
    """6th validate-session from the same IP within an hour gets 429."""
    with respx.mock:
        _mock_github()
        for i in range(5):
            await _create_session(client, f"RL-{i:03d}")
            r = await client.post("/api/v1/validate-session", json={"session_key": f"RL-{i:03d}"})
            assert r.status_code == 200
        await _create_session(client, "RL-005")
        r = await client.post("/api/v1/validate-session", json={"session_key": "RL-005"})
    assert r.status_code == 429


async def test_budget_exhausted_gate(client, active_session):
    """Budget gate returns 402 when llm_spent_usd >= llm_budget_usd."""
    key, sid = active_session
    execute("UPDATE sessions SET llm_spent_usd = llm_budget_usd WHERE id = ?", (sid,))
    r = await client.post(
        "/api/v1/llm/chat/completions",
        json={"messages": [{"role": "user", "content": "hello"}]},
        headers={"Authorization": f"Bearer {key}"},
    )
    assert r.status_code == 402


async def test_submit_enqueues_grade_job(client, active_session):
    key, sid = active_session
    r = await client.post("/api/v1/submit", headers={"Authorization": f"Bearer {key}"})
    assert r.status_code == 202
    jobs = query("SELECT status FROM jobs WHERE session_id = ?", (sid,))
    assert len(jobs) == 1 and jobs[0]["status"] == "pending"


async def test_admin_invites_alias(client):
    """POST /api/v1/admin/invites is equivalent to POST /api/v1/sessions."""
    with respx.mock:
        _mock_github()
        r = await client.post(
            "/api/v1/admin/invites",
            json={"session_key": "INV-001", "candidate_email": "c@test.com", "challenge_id": "cpp-thread-safe-cache"},
            headers=_ADMIN,
        )
    assert r.status_code == 201
    assert "session_id" in r.json()
    assert "branch" in r.json()


async def test_create_session_with_meet_link_round_trip(client):
    """A recruiter-supplied Meet link is stored on the session and returned
    via validate-session so the extension can show the candidate a Join button."""
    with respx.mock:
        _mock_github()
        meet_link = "https://meet.google.com/abc-defg-hij"
        r = await client.post(
            "/api/v1/sessions",
            json={
                "session_key": "PANEL-001",
                "candidate_email": "c@test.com",
                "challenge_id": "cpp-thread-safe-cache",
                "meet_link": meet_link,
            },
            headers=_ADMIN,
        )
        assert r.status_code == 201
        assert r.json()["meet_link"] == meet_link
        assert r.json()["video_platform"] == "google_meet"

        rows = query("SELECT meet_link, video_platform FROM sessions WHERE session_key = ?", ("PANEL-001",))
        assert rows[0]["meet_link"] == meet_link
        assert rows[0]["video_platform"] == "google_meet"

        r = await client.post("/api/v1/validate-session", json={"session_key": "PANEL-001"})
        assert r.status_code == 200
        body = r.json()
        assert body["meet_link"] == meet_link
        assert body["video_platform"] == "google_meet"


async def test_create_session_without_meet_link_is_async(client):
    """When no meet_link is supplied the session validates with meet_link=None
    so the candidate-side UI stays in the existing async-interview mode."""
    with respx.mock:
        _mock_github()
        await _create_session(client, "ASYNC-001")
        r = await client.post("/api/v1/validate-session", json={"session_key": "ASYNC-001"})
        assert r.status_code == 200
        body = r.json()
        assert body["meet_link"] is None
        # Default platform is recorded even when no link is attached, so a
        # later edit (adding a link) can stay on the same platform field.
        assert body["video_platform"] == "google_meet"


async def test_create_session_rejects_non_https_meet_link(client):
    """meet_link must be https — http:// or javascript: schemes are refused."""
    r = await client.post(
        "/api/v1/sessions",
        json={
            "session_key": "BAD-001",
            "candidate_email": "c@test.com",
            "challenge_id": "cpp-thread-safe-cache",
            "meet_link": "http://meet.google.com/abc",
        },
        headers=_ADMIN,
    )
    assert r.status_code == 422


async def test_panel_session_round_trip_with_schedule_and_panelists(client, monkeypatch):
    """A panel-mode session stores the scheduled time + panelists, returns the
    schedule via validate-session, and triggers one invite per recipient."""
    sent: list[dict] = []

    async def fake_send_invite(*args, **kwargs):
        sent.append({"kind": "candidate", "args": args, "kwargs": kwargs})

    async def fake_send_panel(*args, **kwargs):
        sent.append({"kind": "panel", "args": args, "kwargs": kwargs})

    monkeypatch.setattr("vibe.sessions.send_invite", fake_send_invite)
    monkeypatch.setattr("vibe.sessions.send_panelist_invite", fake_send_panel)

    with respx.mock:
        _mock_github()
        # Past timestamp on purpose — this test is about the panel-config
        # round-trip (DB write, validate-session response shape, panel invites),
        # NOT the early-start gate. A future schedule would be intercepted by
        # the gate and return 403 before we can verify the round-trip.
        scheduled = 1_700_000_000  # 2023-11-14
        r = await client.post(
            "/api/v1/sessions",
            json={
                "session_key": "PANEL-002",
                "candidate_email": "c@test.com",
                "challenge_id": "cpp-thread-safe-cache",
                "meet_link": "https://meet.google.com/abc-defg-hij",
                "scheduled_at": scheduled,
                "panelist_emails": ["lead@x.com", "Lead@x.com", "  hm@x.com  "],
            },
            headers=_ADMIN,
        )
        assert r.status_code == 201
        body = r.json()
        assert body["scheduled_at"] == scheduled
        # Pydantic normaliser deduplicates + lowercases + trims.
        assert body["panelist_emails"] == ["lead@x.com", "hm@x.com"]

        # DB row holds CSV in the same canonical form.
        rows = query("SELECT scheduled_at, panelist_emails FROM sessions WHERE session_key='PANEL-002'")
        assert rows[0]["scheduled_at"] == scheduled
        assert rows[0]["panelist_emails"] == "lead@x.com,hm@x.com"

        # Validate-session exposes the schedule so the extension can render
        # the countdown.
        v = await client.post("/api/v1/validate-session", json={"session_key": "PANEL-002"})
        assert v.status_code == 200
        assert v.json()["scheduled_at"] == scheduled

    # One candidate invite + one invite per deduplicated panelist.
    kinds = [s["kind"] for s in sent]
    assert kinds.count("candidate") == 1
    assert kinds.count("panel") == 2
    panel_recipients = sorted(s["args"][0] for s in sent if s["kind"] == "panel")
    assert panel_recipients == ["hm@x.com", "lead@x.com"]


async def test_panel_session_rejects_invalid_panelist_email(client):
    """Panelist emails must contain '@' — bad entries fail validation."""
    r = await client.post(
        "/api/v1/sessions",
        json={
            "session_key": "BAD-PANEL-001",
            "candidate_email": "c@test.com",
            "challenge_id": "cpp-thread-safe-cache",
            "meet_link": "https://meet.google.com/abc",
            "panelist_emails": ["valid@x.com", "not-an-email"],
        },
        headers=_ADMIN,
    )
    assert r.status_code == 422


async def test_panel_session_rejects_scheduled_at_in_millis(client):
    """A common JS slip is passing Date.now() (ms) instead of seconds — we
    reject anything outside a plausible 2010–2100 epoch-seconds range."""
    r = await client.post(
        "/api/v1/sessions",
        json={
            "session_key": "BAD-SCHED-001",
            "candidate_email": "c@test.com",
            "challenge_id": "cpp-thread-safe-cache",
            "scheduled_at": 1_800_000_000_000,  # 2027 in milliseconds
        },
        headers=_ADMIN,
    )
    assert r.status_code == 422


# ── Early-start gate for scheduled panel interviews ──────────────────────────
#
# A scheduled panel session must not let the candidate clone/start before the
# scheduled time — interviewers won't be on the call yet, and starting early
# would burn the candidate's countdown before they're supposed to begin.
# These tests pin the gate's edges: panel vs. async, future vs. past schedule,
# panelists-only (no meet link) — only future-scheduled PANEL sessions are
# blocked; everything else still validates and the session goes ACTIVE.


async def test_validate_session_rejects_future_scheduled_panel(client):
    """A panel session whose scheduled_at is in the future returns 403 with a
    structured detail carrying scheduled_at and a candidate-friendly message.
    The session must stay PENDING (no branch was created, timer not started)."""
    import time as _time

    future = int(_time.time()) + 3600  # 1 hour from now
    with respx.mock:
        _mock_github()
        await client.post(
            "/api/v1/sessions",
            json={
                "session_key": "EARLY-001",
                "candidate_email": "c@test.com",
                "challenge_id": "cpp-thread-safe-cache",
                "meet_link": "https://meet.google.com/abc-defg-hij",
                "scheduled_at": future,
            },
            headers=_ADMIN,
        )
        r = await client.post(
            "/api/v1/validate-session", json={"session_key": "EARLY-001"}
        )

    assert r.status_code == 403
    detail = r.json()["detail"]
    assert detail["code"] == "session_not_yet_open"
    assert detail["scheduled_at"] == future
    assert "scheduled for" in detail["message"]

    # The branch-creation path must not have run — session is still pending.
    rows = query("SELECT status FROM sessions WHERE session_key = ?", ("EARLY-001",))
    assert rows[0]["status"] == "pending"


async def test_validate_session_allows_past_scheduled_panel(client):
    """A panel session whose scheduled_at is in the past validates normally —
    the gate is only for early-starters, not late-starters."""
    import time as _time

    past = int(_time.time()) - 600  # 10 min ago
    with respx.mock:
        _mock_github()
        await client.post(
            "/api/v1/sessions",
            json={
                "session_key": "ONTIME-001",
                "candidate_email": "c@test.com",
                "challenge_id": "cpp-thread-safe-cache",
                "meet_link": "https://meet.google.com/abc-defg-hij",
                "scheduled_at": past,
            },
            headers=_ADMIN,
        )
        r = await client.post(
            "/api/v1/validate-session", json={"session_key": "ONTIME-001"}
        )

    assert r.status_code == 200
    assert r.json()["scheduled_at"] == past


async def test_validate_session_allows_future_scheduled_async(client):
    """An async session (no meet_link, no panelists) is never gated, even when
    scheduled_at is in the future — only panel interviews need the gate."""
    import time as _time

    future = int(_time.time()) + 3600
    with respx.mock:
        _mock_github()
        await client.post(
            "/api/v1/sessions",
            json={
                "session_key": "ASYNC-FUT-001",
                "candidate_email": "c@test.com",
                "challenge_id": "cpp-thread-safe-cache",
                "scheduled_at": future,
            },
            headers=_ADMIN,
        )
        r = await client.post(
            "/api/v1/validate-session", json={"session_key": "ASYNC-FUT-001"}
        )

    assert r.status_code == 200


async def test_validate_session_allows_panel_without_schedule(client):
    """A panel session with no scheduled_at has no gate — start anytime."""
    with respx.mock:
        _mock_github()
        await client.post(
            "/api/v1/sessions",
            json={
                "session_key": "PANEL-NOSCHED-001",
                "candidate_email": "c@test.com",
                "challenge_id": "cpp-thread-safe-cache",
                "meet_link": "https://meet.google.com/abc-defg-hij",
            },
            headers=_ADMIN,
        )
        r = await client.post(
            "/api/v1/validate-session", json={"session_key": "PANEL-NOSCHED-001"}
        )

    assert r.status_code == 200


async def test_validate_session_blocks_panelists_only_future_schedule(client, monkeypatch):
    """The panel signal is meet_link OR panelist_emails — a future-scheduled
    session with panelists but no meet_link is still gated."""
    import time as _time

    # Stub the panel-invite path so the test doesn't try to send real emails.
    async def _noop(*a, **kw):
        return None

    monkeypatch.setattr("vibe.sessions.send_invite", _noop)
    monkeypatch.setattr("vibe.sessions.send_panelist_invite", _noop)

    future = int(_time.time()) + 3600
    with respx.mock:
        _mock_github()
        await client.post(
            "/api/v1/sessions",
            json={
                "session_key": "PANELISTS-001",
                "candidate_email": "c@test.com",
                "challenge_id": "cpp-thread-safe-cache",
                "panelist_emails": ["lead@x.com"],
                "scheduled_at": future,
            },
            headers=_ADMIN,
        )
        r = await client.post(
            "/api/v1/validate-session", json={"session_key": "PANELISTS-001"}
        )

    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "session_not_yet_open"


def test_build_ics_generates_valid_vevent():
    """The .ics generator emits a single VEVENT with UTC DTSTART/DTEND, CRLF
    line endings, and one ATTENDEE line per recipient."""
    from vibe.email import _build_ics

    ics = _build_ics(
        session_id="abc123",
        scheduled_at=1_800_000_000,  # 2027-01-15 08:00:00 UTC
        max_minutes=60,
        challenge_id="cpp-thread-safe-cache",
        meet_link="https://meet.google.com/xyz",
        organizer_email="ops@jivahire.com",
        attendee_emails=["c@test.com", "lead@x.com"],
    )
    # CRLF per RFC 5545.
    assert "\r\n" in ics
    assert "BEGIN:VCALENDAR" in ics and "END:VCALENDAR" in ics
    assert "BEGIN:VEVENT" in ics and "END:VEVENT" in ics
    assert "UID:abc123@jivahire" in ics
    assert "METHOD:REQUEST" in ics
    # Start in UTC iCal format
    assert "DTSTART:20270115T080000Z" in ics
    # Duration = 60 min → end at 09:00:00 Z
    assert "DTEND:20270115T090000Z" in ics
    assert "LOCATION:https://meet.google.com/xyz" in ics
    assert "ATTENDEE" in ics
    assert "mailto:c@test.com" in ics
    assert "mailto:lead@x.com" in ics
    assert "ORGANIZER:mailto:ops@jivahire.com" in ics


def test_build_ics_escapes_special_chars():
    """RFC 5545 §3.3.11 requires commas, semicolons, backslashes and newlines
    in TEXT values to be escaped, otherwise calendar clients reject the file."""
    from vibe.email import _build_ics

    ics = _build_ics(
        session_id="evil",
        scheduled_at=1_800_000_000,
        max_minutes=30,
        challenge_id="weird, name; with\nnewline",
        meet_link="https://example.com/a,b",
        organizer_email="ops@jivahire.com",
        attendee_emails=["c@test.com"],
    )
    # The unescaped comma/semicolon/newline must not appear in the SUMMARY line.
    summary_line = next(ln for ln in ics.split("\r\n") if ln.startswith("SUMMARY:"))
    assert "\\," in summary_line
    assert "\\;" in summary_line
    assert "\\n" in summary_line
    # And no raw newline mid-line.
    assert summary_line.count("\n") == 0


async def test_job_claim_atomicity():
    """Two threads racing to claim the same pending job — exactly one wins."""
    from vibe.jobs import claim_job
    execute(
        "INSERT INTO sessions (id, session_key, candidate_email, challenge_id, branch_name, status) "
        "VALUES ('s1', 'K-001', 'x@x.com', 'cpp-thread-safe-cache', 'interview/s1', 'submitted')"
    )
    execute("INSERT INTO jobs (kind, session_id) VALUES ('grade', 's1')")

    results: list = []

    def try_claim():
        results.append(claim_job())

    t1, t2 = threading.Thread(target=try_claim), threading.Thread(target=try_claim)
    t1.start(); t2.start()
    t1.join(); t2.join()
    assert len([r for r in results if r is not None]) == 1


# ── GitHub App token integration ─────────────────────────────────────────────


async def test_validate_session_returns_scoped_installation_token(client):
    """validate-session must return a `ghs_` installation token (NOT a `ghp_*`
    PAT) plus an expiration timestamp the extension can use to schedule
    refreshes. This pins the security contract: a candidate-facing token is
    short-lived and scoped to one repo."""
    with respx.mock:
        _mock_github()
        await _create_session(client, "GHA-001")
        r = await client.post("/api/v1/validate-session", json={"session_key": "GHA-001"})
    assert r.status_code == 200
    body = r.json()
    assert body["github_clone_token"].startswith("ghs_"), \
        "candidate must receive an installation token, never a PAT"
    # Stub returns the repo name embedded in the token — pins that the mint
    # call was scoped to the candidate's repo, not minted globally.
    assert "test-org/test-repo" in body["github_clone_token"]
    assert isinstance(body["github_clone_token_expires_at"], int)
    assert body["github_clone_token_expires_at"] > 0


async def test_refresh_github_token_active_session(client, active_session):
    """An active session can mint fresh tokens via the refresh endpoint."""
    key, _ = active_session
    r = await client.post(
        "/api/v1/refresh-github-token",
        headers={"Authorization": f"Bearer {key}"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["github_clone_token"].startswith("ghs_")
    assert isinstance(body["github_clone_token_expires_at"], int)


async def test_refresh_github_token_rejects_submitted_session(client, active_session):
    """A submitted session must NOT be able to keep cycling clone tokens —
    that would let a candidate push to their branch after the cutoff."""
    key, sid = active_session
    execute("UPDATE sessions SET status='submitted' WHERE id = ?", (sid,))
    r = await client.post(
        "/api/v1/refresh-github-token",
        headers={"Authorization": f"Bearer {key}"},
    )
    assert r.status_code == 409


async def test_refresh_github_token_requires_bearer(client):
    r = await client.post("/api/v1/refresh-github-token")
    assert r.status_code == 401


# ── End-of-interview video gating ────────────────────────────────────────────
# The post-submit explainer video defaults to "required for async, skipped for
# panel". A per-session `require_end_video` flag overrides the panel skip so
# recruiters can force a recording even when a meet link is attached.


def _enable_video_feature(monkeypatch):
    """Force the S3/CloudFront feature flag on for tests — we monkeypatch the
    bound names in each module rather than the env so we don't have to spin
    up boto3 to satisfy the upload code paths."""
    monkeypatch.setattr("vibe.sessions.video_feature_enabled", lambda: True)
    monkeypatch.setattr("vibe.submit.video_feature_enabled", lambda: True)


async def test_validate_session_require_end_video_true_for_async(client, monkeypatch):
    _enable_video_feature(monkeypatch)
    with respx.mock:
        _mock_github()
        await _create_session(client, "VID-ASYNC-001")
        r = await client.post("/api/v1/validate-session", json={"session_key": "VID-ASYNC-001"})
    assert r.status_code == 200
    assert r.json()["require_end_video"] is True


async def test_validate_session_require_end_video_false_for_panel_default(client, monkeypatch):
    _enable_video_feature(monkeypatch)
    with respx.mock:
        _mock_github()
        await client.post(
            "/api/v1/sessions",
            json={
                "session_key": "VID-PANEL-001",
                "candidate_email": "c@test.com",
                "challenge_id": "cpp-thread-safe-cache",
                "meet_link": "https://meet.google.com/abc-defg-hij",
            },
            headers=_ADMIN,
        )
        r = await client.post("/api/v1/validate-session", json={"session_key": "VID-PANEL-001"})
    assert r.status_code == 200
    assert r.json()["require_end_video"] is False


async def test_validate_session_require_end_video_true_for_panel_override(client, monkeypatch):
    _enable_video_feature(monkeypatch)
    with respx.mock:
        _mock_github()
        await client.post(
            "/api/v1/sessions",
            json={
                "session_key": "VID-PANEL-002",
                "candidate_email": "c@test.com",
                "challenge_id": "cpp-thread-safe-cache",
                "meet_link": "https://meet.google.com/abc-defg-hij",
                "require_end_video": True,
            },
            headers=_ADMIN,
        )
        # Persisted on the row so other code paths (submit gating) can read it.
        rows = query(
            "SELECT require_end_video FROM sessions WHERE session_key='VID-PANEL-002'"
        )
        assert rows[0]["require_end_video"] == 1
        r = await client.post("/api/v1/validate-session", json={"session_key": "VID-PANEL-002"})
    assert r.status_code == 200
    assert r.json()["require_end_video"] is True


async def test_validate_session_require_end_video_false_when_feature_disabled(client, monkeypatch):
    """Server is mis-configured (no S3 / CloudFront) — never ask the candidate
    to record a video they can't actually upload, even on an async session."""
    monkeypatch.setattr("vibe.sessions.video_feature_enabled", lambda: False)
    with respx.mock:
        _mock_github()
        await _create_session(client, "VID-NOFEAT-001")
        r = await client.post("/api/v1/validate-session", json={"session_key": "VID-NOFEAT-001"})
    assert r.status_code == 200
    assert r.json()["require_end_video"] is False


async def test_submit_skips_video_upload_for_panel_default(client, monkeypatch):
    """Panel session, no override → submit response omits `video_upload`."""
    _enable_video_feature(monkeypatch)
    with respx.mock:
        _mock_github()
        await client.post(
            "/api/v1/sessions",
            json={
                "session_key": "SUB-PANEL-001",
                "candidate_email": "c@test.com",
                "challenge_id": "cpp-thread-safe-cache",
                "meet_link": "https://meet.google.com/abc-defg-hij",
            },
            headers=_ADMIN,
        )
        await client.post("/api/v1/validate-session", json={"session_key": "SUB-PANEL-001"})
        r = await client.post(
            "/api/v1/submit",
            headers={"Authorization": "Bearer SUB-PANEL-001"},
        )
    assert r.status_code == 202
    assert "video_upload" not in r.json()


async def test_submit_includes_video_upload_for_panel_when_override(client, monkeypatch):
    """Panel session with require_end_video=True → submit response carries the
    `video_upload` block so the extension mints a browser recording link."""
    _enable_video_feature(monkeypatch)
    with respx.mock:
        _mock_github()
        await client.post(
            "/api/v1/sessions",
            json={
                "session_key": "SUB-PANEL-002",
                "candidate_email": "c@test.com",
                "challenge_id": "cpp-thread-safe-cache",
                "meet_link": "https://meet.google.com/abc-defg-hij",
                "require_end_video": True,
            },
            headers=_ADMIN,
        )
        await client.post("/api/v1/validate-session", json={"session_key": "SUB-PANEL-002"})
        r = await client.post(
            "/api/v1/submit",
            headers={"Authorization": "Bearer SUB-PANEL-002"},
        )
    assert r.status_code == 202
    body = r.json()
    assert "video_upload" in body
    assert body["video_upload"]["min_duration_seconds"] >= 1


async def test_invite_email_mentions_end_video_when_required(client, monkeypatch):
    """Async session (always requires end video when the feature is enabled)
    — the invite email carries the heads-up section. Panel session without
    the override does not."""
    _enable_video_feature(monkeypatch)
    captured: list[dict] = []

    async def fake_send_invite(*args, **kwargs):
        captured.append(kwargs)

    monkeypatch.setattr("vibe.sessions.send_invite", fake_send_invite)
    with respx.mock:
        _mock_github()
        await _create_session(client, "MAIL-ASYNC-001")
        await client.post(
            "/api/v1/sessions",
            json={
                "session_key": "MAIL-PANEL-001",
                "candidate_email": "c@test.com",
                "challenge_id": "cpp-thread-safe-cache",
                "meet_link": "https://meet.google.com/abc-defg-hij",
            },
            headers=_ADMIN,
        )
    assert captured[0]["require_end_video"] is True
    assert captured[1]["require_end_video"] is False


# ── org scoping (recruiter-backend proxy passes org_id) ───────────────────────

async def _create_session_org(client, key: str, org_id: str | None) -> str:
    body = {"session_key": key, "candidate_email": "c@test.com", "challenge_id": "cpp-thread-safe-cache"}
    if org_id is not None:
        body["org_id"] = org_id
    r = await client.post("/api/v1/sessions", json=body, headers=_ADMIN)
    assert r.status_code == 201
    return r.json()["session_id"]


async def test_list_sessions_scoped_by_org(client):
    """GET /sessions?org_id=X returns only X's sessions; omitting it returns all."""
    with respx.mock:
        _mock_github()
        await _create_session_org(client, "ORG-A-1", "org-A")
        await _create_session_org(client, "ORG-B-1", "org-B")
        await _create_session_org(client, "ORG-NONE-1", None)

    a = await client.get("/api/v1/sessions", params={"org_id": "org-A"}, headers=_ADMIN)
    assert a.status_code == 200
    a_keys = {s["session_key"] for s in a.json()["sessions"]}
    assert a_keys == {"ORG-A-1"}

    all_sessions = await client.get("/api/v1/sessions", headers=_ADMIN)
    all_keys = {s["session_key"] for s in all_sessions.json()["sessions"]}
    assert {"ORG-A-1", "ORG-B-1", "ORG-NONE-1"} <= all_keys


async def test_session_detail_scoped_by_org(client):
    """Detail for another org's session is reported as 404; own org gets 200."""
    with respx.mock:
        _mock_github()
        sid_b = await _create_session_org(client, "ORG-B-2", "org-B")

    cross = await client.get(f"/api/v1/sessions/{sid_b}", params={"org_id": "org-A"}, headers=_ADMIN)
    assert cross.status_code == 404

    own = await client.get(f"/api/v1/sessions/{sid_b}", params={"org_id": "org-B"}, headers=_ADMIN)
    assert own.status_code == 200
    assert own.json()["session"]["org_id"] == "org-B"


# ── list search / status filtering (backend-level) ────────────────────────────

async def test_list_sessions_search_filter(client):
    """`search` matches a substring of candidate email / session key / challenge id."""
    with respx.mock:
        _mock_github()
        await client.post(
            "/api/v1/sessions",
            json={"session_key": "ALPHA-1", "candidate_email": "alice@acme.com", "challenge_id": "cpp-thread-safe-cache"},
            headers=_ADMIN,
        )
        await client.post(
            "/api/v1/sessions",
            json={"session_key": "BETA-1", "candidate_email": "bob@globex.com", "challenge_id": "cpp-thread-safe-cache"},
            headers=_ADMIN,
        )

    by_email = await client.get("/api/v1/sessions", params={"search": "globex"}, headers=_ADMIN)
    assert by_email.status_code == 200
    assert {s["session_key"] for s in by_email.json()["sessions"]} == {"BETA-1"}

    by_key = await client.get("/api/v1/sessions", params={"search": "alpha"}, headers=_ADMIN)
    assert {s["session_key"] for s in by_key.json()["sessions"]} == {"ALPHA-1"}


async def test_list_sessions_status_filter(client):
    """`status` (repeatable) restricts the result to the given lifecycle states."""
    with respx.mock:
        _mock_github()
        await _create_session(client, "PEND-1")
        await _create_session(client, "PEND-2")
    # Flip one row to 'submitted' so the filter has two distinct states to split.
    execute("UPDATE sessions SET status='submitted' WHERE session_key='PEND-1'")

    submitted = await client.get("/api/v1/sessions", params={"status": "submitted"}, headers=_ADMIN)
    assert submitted.status_code == 200
    keys = {s["session_key"] for s in submitted.json()["sessions"]}
    assert keys == {"PEND-1"}

    # Repeated status params union the states.
    both = await client.get(
        "/api/v1/sessions?status=submitted&status=pending", headers=_ADMIN
    )
    assert {s["session_key"] for s in both.json()["sessions"]} == {"PEND-1", "PEND-2"}


async def test_list_sessions_invalid_status_rejected(client):
    """An unknown status yields 400, not a silent empty result."""
    r = await client.get("/api/v1/sessions", params={"status": "bogus"}, headers=_ADMIN)
    assert r.status_code == 400


async def test_list_sessions_pagination(client):
    """limit/offset page the filtered set; total reports the full filtered count."""
    with respx.mock:
        _mock_github()
        for i in range(5):
            await _create_session(client, f"PAGE-{i}")

    page1 = await client.get("/api/v1/sessions", params={"limit": 2, "offset": 0}, headers=_ADMIN)
    assert page1.status_code == 200
    body1 = page1.json()
    assert body1["total"] == 5
    assert body1["limit"] == 2 and body1["offset"] == 0
    assert len(body1["sessions"]) == 2

    last = await client.get("/api/v1/sessions", params={"limit": 2, "offset": 4}, headers=_ADMIN)
    body_last = last.json()
    assert len(body_last["sessions"]) == 1  # only one row left on the last page
    assert body_last["total"] == 5

    # Walking every page yields each row exactly once (no gaps, no overlap).
    seen: list[str] = []
    for off in (0, 2, 4):
        page = await client.get(
            "/api/v1/sessions", params={"limit": 2, "offset": off}, headers=_ADMIN
        )
        seen.extend(s["session_key"] for s in page.json()["sessions"])
    assert sorted(seen) == [f"PAGE-{i}" for i in range(5)]


async def test_list_sessions_total_reflects_filter(client):
    """`total` counts the filtered set, not the whole table."""
    with respx.mock:
        _mock_github()
        await _create_session(client, "KEEP-1")
        await _create_session(client, "KEEP-2")
        await _create_session(client, "OTHER-1")

    r = await client.get(
        "/api/v1/sessions", params={"search": "keep", "limit": 1}, headers=_ADMIN
    )
    body = r.json()
    assert body["total"] == 2  # two KEEP rows match the filter
    assert len(body["sessions"]) == 1  # but only one returned this page


async def test_list_sessions_invalid_pagination_rejected(client):
    """Negative offset / zero-or-negative limit are rejected with 400."""
    assert (await client.get("/api/v1/sessions", params={"limit": 0}, headers=_ADMIN)).status_code == 400
    assert (await client.get("/api/v1/sessions", params={"offset": -1}, headers=_ADMIN)).status_code == 400
