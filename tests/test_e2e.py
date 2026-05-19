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
    "GITHUB_BOT_PAT": "ghp-test",
    "GITHUB_CHALLENGES_REPO": "test-org/test-repo",
    "GITHUB_CHALLENGES_OWNER": "",
    "ADMIN_TOKEN": "admin-secret",
    "DB_PATH": _db_path,
    "LLM_BASE_URL": "https://openrouter.ai/api/v1",
})

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
        json={"session_key": key, "candidate_email": "c@test.com", "challenge_id": "cpp-lru-cache"},
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


async def test_telemetry_bulk_insert(client, active_session):
    key, _ = active_session
    events = [{"ts": 1_000_000 + i, "event_type": "edit_batch", "payload": {"chars": i}} for i in range(5)]
    r = await client.post(
        "/api/v1/telemetry",
        json={"events": events},
        headers={"Authorization": f"Bearer {key}"},
    )
    assert r.status_code == 204
    assert query("SELECT COUNT(*) as n FROM telemetry")[0]["n"] == 5


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
            json={"session_key": "INV-001", "candidate_email": "c@test.com", "challenge_id": "cpp-lru-cache"},
            headers=_ADMIN,
        )
    assert r.status_code == 201
    assert "session_id" in r.json()
    assert "branch" in r.json()


async def test_telemetry_window_events(client, active_session):
    """app_focused with time_away_seconds and edit_pasted with suspicious_paste are stored."""
    key, _ = active_session
    events = [
        {"ts": 2_000_000, "event_type": "app_unfocused", "payload": {"ts": 2_000_000}},
        {"ts": 2_005_000, "event_type": "app_focused", "payload": {"time_away_seconds": 5.0}},
        {"ts": 2_005_500, "event_type": "edit_pasted", "payload": {"chars": 50, "suspicious_paste": True}},
    ]
    r = await client.post(
        "/api/v1/telemetry",
        json={"events": events},
        headers={"Authorization": f"Bearer {key}"},
    )
    assert r.status_code == 204
    rows = query("SELECT event_type FROM telemetry ORDER BY ts")
    types = [row["event_type"] for row in rows]
    assert "app_unfocused" in types
    assert "app_focused" in types
    assert "edit_pasted" in types


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
                "challenge_id": "cpp-lru-cache",
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
            "challenge_id": "cpp-lru-cache",
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
        scheduled = 1_800_000_000  # 2027-01-15
        r = await client.post(
            "/api/v1/sessions",
            json={
                "session_key": "PANEL-002",
                "candidate_email": "c@test.com",
                "challenge_id": "cpp-lru-cache",
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
            "challenge_id": "cpp-lru-cache",
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
            "challenge_id": "cpp-lru-cache",
            "scheduled_at": 1_800_000_000_000,  # 2027 in milliseconds
        },
        headers=_ADMIN,
    )
    assert r.status_code == 422


def test_build_ics_generates_valid_vevent():
    """The .ics generator emits a single VEVENT with UTC DTSTART/DTEND, CRLF
    line endings, and one ATTENDEE line per recipient."""
    from vibe.email import _build_ics

    ics = _build_ics(
        session_id="abc123",
        scheduled_at=1_800_000_000,  # 2027-01-15 08:00:00 UTC
        max_minutes=60,
        challenge_id="cpp-lru-cache",
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
        "VALUES ('s1', 'K-001', 'x@x.com', 'cpp-lru-cache', 'interview/s1', 'submitted')"
    )
    execute("INSERT INTO jobs (kind, session_id) VALUES ('grade', 's1')")

    results: list = []

    def try_claim():
        results.append(claim_job())

    t1, t2 = threading.Thread(target=try_claim), threading.Thread(target=try_claim)
    t1.start(); t2.start()
    t1.join(); t2.join()
    assert len([r for r in results if r is not None]) == 1
