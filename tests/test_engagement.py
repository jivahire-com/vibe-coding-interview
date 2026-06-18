"""Unit tests for the engagement / no-show gate (vibe.grader.engagement) and
its integration points in the runner summary builders.

The gate floors every non-objective dimension when a candidate submitted
without engaging. These tests pin:
  - assess() is conservative: ANY of {chars, chat, code change} → attended
  - the code-change probe ignores the extension's `.jivahire/` bookkeeping
  - the probe fails closed (no false code-change) when it can't read a clone,
    leaving the authorship counters to carry a genuine attempt
  - runner summary builders surface the no-show note instead of the weakest
    signal/criterion
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

import pytest

_db_fd, _db_path = tempfile.mkstemp(suffix=".db")
os.environ.setdefault("OPENAI_API_KEY", "sk-test")
os.environ.setdefault("GITHUB_BOT_PAT", "ghp-test")
os.environ.setdefault("GITHUB_CHALLENGES_OWNER", "")
os.environ.setdefault("GITHUB_CHALLENGES_REPO", "test-org/test-repo")
os.environ.setdefault("ADMIN_TOKEN", "admin-secret")
os.environ.setdefault("DB_PATH", _db_path)
os.environ.setdefault("LLM_BASE_URL", "https://openrouter.ai/api/v1")

from vibe.db import bootstrap, execute  # noqa: E402
from vibe.grader import engagement, runner  # noqa: E402

bootstrap()


@pytest.fixture(autouse=True)
def _clean():
    for tbl in ("grades", "jobs", "chat_exchanges", "telemetry", "sessions"):
        execute(f"DELETE FROM {tbl}")
    yield


def _seed(sid: str, *, typed=0, pasted=0, ai_applied=0) -> None:
    execute(
        "INSERT INTO sessions (id, session_key, candidate_email, challenge_id, "
        " branch_name, status, typed_chars, pasted_chars, ai_applied_chars) "
        "VALUES (?, ?, 'c@test.com', 'python-ttl-cache', ?, 'submitted', ?, ?, ?)",
        (sid, f"KEY-{sid}", f"interview/{sid}", typed, pasted, ai_applied),
    )


def _add_chat(sid: str) -> None:
    execute(
        "INSERT INTO chat_exchanges (session_id, ts, model, prompt_tokens, "
        " completion_tokens, cost_usd) VALUES (?, 1, 'gpt', 1, 1, 0.0)",
        (sid,),
    )


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def _make_repo(tmp_path: Path, *, change_code=False, add_jivahire=False) -> Path:
    """A branch clone mirroring real provisioning: non-`auto:` setup commits
    (the starter the candidate is handed), then the candidate's own `auto:`
    commits — an empty 3-min timer commit, and optionally a `.jivahire/`
    telemetry commit and/or a real code edit. The candidate baseline is the
    newest non-`auto:` commit, so only the `auto:` commits count as their work."""
    repo = tmp_path / "clone"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "t@t.com")
    _git(repo, "config", "user.name", "t")
    (repo / "main.py").write_text("def f():\n    return 1\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "Initial challenge starter")
    _git(repo, "commit", "-q", "--allow-empty",
         "-m", "chore: provision candidate workspace")
    # Empty auto-commit — what a no-show's 3-min timer produces.
    _git(repo, "commit", "-q", "--allow-empty", "-m", "auto: 2026-01-01T00:00:00Z")
    if add_jivahire:
        (repo / ".jivahire").mkdir(exist_ok=True)
        (repo / ".jivahire" / "telemetry.jsonl").write_text('{"e":1}\n')
        _git(repo, "add", "-A")
        _git(repo, "commit", "-q", "-m", "auto: 2026-01-01T00:03:00Z")
    if change_code:
        (repo / "main.py").write_text("def f():\n    return 2  # edit\n")
        _git(repo, "add", "-A")
        _git(repo, "commit", "-q", "-m", "auto: 2026-01-01T00:06:00Z")
    return repo


def test_no_show_when_nothing(tmp_path):
    _seed("ns")
    repo = _make_repo(tmp_path)
    out = engagement.assess("ns", repo)
    assert out["attended"] is False
    assert out["reason"] and "did not attempt" in out["reason"]
    assert out["signals"]["code_changed"] is False


def test_jivahire_telemetry_commit_does_not_count_as_engagement(tmp_path):
    _seed("ns2")
    repo = _make_repo(tmp_path, add_jivahire=True)
    out = engagement.assess("ns2", repo)
    # The committed telemetry JSONL is bookkeeping, not candidate code.
    assert out["signals"]["code_changed"] is False
    assert out["attended"] is False


def test_setup_commit_before_candidate_is_not_engagement(tmp_path):
    # Reproduces the real no-show: provisioning re-syncs the starter (a large
    # code change) BEFORE the candidate starts, then the candidate only produces
    # empty auto-commits. That setup change must not read as candidate work.
    _seed("setup")
    repo = tmp_path / "clone"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "t@t.com")
    _git(repo, "config", "user.name", "t")
    (repo / "main.py").write_text("def f():\n    return 1\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "Initial challenge starter")
    # Non-auto setup commit that rewrites code — the provisioning re-sync.
    (repo / "main.py").write_text("def f():\n    return 999  # canonical\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "Update starter to canonical challenge package")
    # Candidate then does nothing but tick the 3-min timer.
    _git(repo, "commit", "-q", "--allow-empty", "-m", "auto: 2026-01-01T00:00:00Z")
    out = engagement.assess("setup", repo)
    assert out["signals"]["code_changed"] is False
    assert out["attended"] is False


def test_attended_when_typed(tmp_path):
    _seed("typed", typed=500)
    repo = _make_repo(tmp_path)
    assert engagement.assess("typed", repo)["attended"] is True


def test_trivial_keystrokes_still_no_show(tmp_path):
    _seed("trivial", typed=5)  # below _MIN_ENGAGED_CHARS
    repo = _make_repo(tmp_path)
    assert engagement.assess("trivial", repo)["attended"] is False


def test_attended_when_chat(tmp_path):
    _seed("chat")
    _add_chat("chat")
    repo = _make_repo(tmp_path)
    assert engagement.assess("chat", repo)["attended"] is True


def test_attended_when_code_changed(tmp_path):
    _seed("coded")
    repo = _make_repo(tmp_path, change_code=True)
    out = engagement.assess("coded", repo)
    assert out["signals"]["code_changed"] is True
    assert out["attended"] is True


def test_no_clone_relies_on_authorship_counters():
    # With no readable clone the git probe can't prove a code change, so it must
    # NOT assert engagement on its own — otherwise a no-show slips past the
    # floor. A true no-show (no chars, no chat) is flagged...
    _seed("noclone")
    out = engagement.assess("noclone", None)
    assert out["signals"]["code_changed"] is False
    assert out["attended"] is False

    # ...while a real attempt is still saved by its authorship counters.
    _seed("noclone-coded", typed=200)
    out2 = engagement.assess("noclone-coded", None)
    assert out2["signals"]["code_changed"] is False
    assert out2["attended"] is True


def test_floor_constant_is_near_zero_not_zero():
    assert 0 < engagement.NEAR_ZERO < 1


# ─── runner flooring gate surfaces the no-show note ──────────────────────────


def test_no_show_floors_non_objective_dims_and_records_note():
    note = engagement.NO_SHOW_NOTE
    dims = {
        "tests": {"score": 9.0, "subpoints": []},            # objective — excluded
        "code_quality": {"score": 8.0, "subpoints": []},      # non-objective — floored
        "verification_discipline": {"score": 7.0, "subpoints": []},
    }
    runner._floor_dims(dims, ["code_quality", "verification_discipline"], note, key="no_show")
    assert dims["tests"]["score"] == 9.0
    assert dims["code_quality"]["score"] <= engagement.NEAR_ZERO
    assert dims["code_quality"]["note"] == note
    assert dims["code_quality"]["no_show"] is True
