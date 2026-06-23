"""Starter-vs-final code diff for a session.

The candidate's whole workspace lives on the GitHub branch
``interview/<session_id>``: a chain of provisioning commits (the variant
starter, with the ``.jivahire`` answer key stripped) followed by the
candidate's own ``auto: <timestamp>`` commits. The newest *non*-``auto:``
commit — ``candidate_base()`` in :mod:`vibe.grader.git_ops` — IS the starter
exactly as it was handed to the candidate; ``HEAD`` is their final submission.
So one ``git diff <base> HEAD`` is the "starter variant vs final submission"
a recruiter wants to review.

This module clones the branch (the same shallow clone the grader uses),
computes that diff, and returns it as structured per-file data plus a combined
unified patch — leaving *rendering* (side-by-side, inline, syntax highlight) to
the UI. See ``CODE_DIFF_UI.md`` for the rendering contract.

Admin-token gated and org-scoped, the same trust boundary as the rest of the
recruiter dashboard.
"""

import shutil
import subprocess
import tempfile
from pathlib import Path

from fastapi import APIRouter, Header, HTTPException

from vibe.config import repo_for_challenge, settings
from vibe.db import query
from vibe.grader.git_ops import clone_branch

router = APIRouter(prefix="/api/v1")

# The git "empty tree" object. Used as the diff base when no starter commit is
# found, so every file reads as added rather than the diff silently folding
# setup history into the candidate's work.
_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

# The git identity the extension stamps on every candidate commit — both the
# 3-min ``auto:`` snapshots and the final ``submit:`` commit (see
# extension/src/submit.ts). The starter baseline is the newest commit *not*
# authored by this identity, i.e. the provisioning commit that stripped the
# answer key. (grader.git_ops.candidate_base keys on the ``auto:`` subject
# prefix alone, so it misclassifies the final ``submit:`` commit as the
# baseline and yields an empty diff — hence the author-based check here.)
_CANDIDATE_EMAIL = "candidate@vibe-interview.local"

# Per-file content cap. Past this we omit the text (``truncated: true``) so a
# checked-in vendored blob or generated artefact can't bloat the payload; the
# numstat counts and per-file patch still describe the change.
_MAX_FILE_BYTES = 200_000

# Statuses where the candidate branch exists on GitHub (validate-session has
# run). A 'pending' session has no branch yet, so there is nothing to diff.
_HAS_BRANCH = {"active", "submitted", "graded", "grading_failed"}

_STATUS_LABEL = {"A": "added", "M": "modified", "D": "deleted", "R": "renamed", "C": "copied"}


def _git(clone_dir: Path, *args: str, timeout: int = 30) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(clone_dir), *args],
        capture_output=True, timeout=timeout,
    )


def _head_sha(clone_dir: Path) -> str:
    out = _git(clone_dir, "rev-parse", "HEAD")
    return out.stdout.decode("utf-8", "replace").strip()


def _starter_base(clone_dir: Path) -> str | None:
    """SHA of the starter as delivered: the newest commit *not* authored by the
    candidate. All candidate commits — ``auto:`` snapshots and the final
    ``submit:`` — are authored as ``_CANDIDATE_EMAIL``; every earlier commit
    (the answer-key-stripping provisioning commit, the starter import) is a bot
    or recruiter. Returns None when no such commit is reachable (or git can't be
    read), so the caller falls back to the empty tree."""
    out = _git(clone_dir, "log", "HEAD", "--pretty=%H%x00%ae")
    if out.returncode != 0:
        return None
    for line in out.stdout.decode("utf-8", "replace").splitlines():
        sha, _, email = line.partition("\x00")
        if email.strip().lower() != _CANDIDATE_EMAIL:
            return sha
    return None


def _file_at(clone_dir: Path, ref: str, path: str) -> tuple[str | None, bool, bool]:
    """``(text, is_binary, truncated)`` for ``path`` at ``ref``.

    ``text`` is None when the file is absent at that ref (e.g. an added file has
    no starter side), binary, or truncated — the two flags disambiguate which.
    """
    out = _git(clone_dir, "show", f"{ref}:{path}")
    if out.returncode != 0:
        return None, False, False  # path does not exist at this ref
    raw = out.stdout
    if len(raw) > _MAX_FILE_BYTES:
        return None, False, True
    if b"\x00" in raw:
        return None, True, False
    return raw.decode("utf-8", "replace"), False, False


def _numstat(clone_dir: Path, base: str, head: str) -> dict[str, tuple[int | None, int | None]]:
    """``{path: (additions, deletions)}`` over ``base..head``. Binary files
    report ``(None, None)`` (git prints ``-\t-`` for them)."""
    out = _git(clone_dir, "diff", "--numstat", "-M", base, head)
    counts: dict[str, tuple[int | None, int | None]] = {}
    for line in out.stdout.decode("utf-8", "replace").splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        adds, dels, path = parts[0], parts[1], parts[-1]
        counts[path] = (
            None if adds == "-" else int(adds),
            None if dels == "-" else int(dels),
        )
    return counts


def _changed_files(clone_dir: Path, base: str, head: str) -> list[dict]:
    """Parse ``git diff --name-status`` into ``{status, path, old_path}`` rows."""
    out = _git(clone_dir, "diff", "--name-status", "-M", base, head)
    rows: list[dict] = []
    for line in out.stdout.decode("utf-8", "replace").splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        code = parts[0][:1]  # 'R100' / 'C75' -> 'R' / 'C'
        if code in ("R", "C") and len(parts) >= 3:
            rows.append({"status": _STATUS_LABEL[code], "old_path": parts[1], "path": parts[2]})
        else:
            rows.append({"status": _STATUS_LABEL.get(code, code), "old_path": None, "path": parts[-1]})
    return rows


def _ignored_paths(clone_dir: Path, paths: list[str]) -> set[str]:
    """Subset of ``paths`` the challenge's own ``.gitignore`` declares non-
    committable (e.g. ``build/`` for C++, ``node_modules/`` for JS). ``--no-index``
    consults only the ignore rules, so it still matches paths the candidate
    committed anyway via ``git add -A``. Used to keep generated artefacts out of
    the code diff."""
    if not paths:
        return set()
    out = subprocess.run(
        ["git", "-C", str(clone_dir), "check-ignore", "--no-index", "--stdin"],
        input="\n".join(paths), capture_output=True, text=True, timeout=30,
    )
    if out.returncode not in (0, 1):  # 0=some ignored, 1=none; >1 is an error
        return set()
    return {line.strip() for line in out.stdout.splitlines() if line.strip()}


# The interview's internal directory: the integrity marker and ingested
# telemetry, plus preserved challenge metadata. Never candidate code, so it is
# excluded from the code diff (the telemetry.jsonl alone would otherwise swamp
# it with hundreds of event lines).
_INTERNAL_PREFIX = ".jivahire/"

# Generated / dependency directories that are never candidate source. Used as a
# fallback to ``.gitignore`` because production challenge repos don't always
# commit a .gitignore (so check-ignore finds no rules). Deliberately conservative
# — only unambiguously machine-generated trees — so a hand-written source file is
# never hidden from the recruiter.
_GENERATED_DIRS = frozenset({
    "build", "node_modules", "dist", "__pycache__",
    ".pytest_cache", ".mypy_cache", ".venv", "venv",
})


def _is_generated(path: str) -> bool:
    """True for a build artefact / dependency path (a fallback when the repo
    ships no .gitignore). Matches on a directory component, never the leaf alone,
    so e.g. a source file literally named ``build`` is untouched."""
    parts = path.split("/")
    for component in parts[:-1]:
        if component in _GENERATED_DIRS or component.endswith(".egg-info"):
            return True
    return parts[-1] == ".DS_Store"


def build_code_diff(session: dict, clone_dir: Path) -> dict:
    """Clone the session's branch into ``clone_dir`` and build the starter→final
    diff payload. Caller owns ``clone_dir`` cleanup."""
    repo = repo_for_challenge(session["challenge_id"])
    clone_branch(repo, session["branch_name"], clone_dir)

    head = _head_sha(clone_dir)
    base = _starter_base(clone_dir) or _EMPTY_TREE

    changed = _changed_files(clone_dir, base, head)
    ignored = _ignored_paths(clone_dir, [r["path"] for r in changed])

    counts = _numstat(clone_dir, base, head)
    files: list[dict] = []
    excluded: list[dict] = []
    for row in changed:
        path, old_path, status = row["path"], row["old_path"], row["status"]
        # Drop interview plumbing and anything the challenge gitignores: a code
        # diff should show the candidate's source edits, not the integrity
        # marker or generated build artefacts they happened to commit.
        if path.startswith(_INTERNAL_PREFIX):
            excluded.append({"path": path, "reason": "internal"})
            continue
        if path in ignored:
            excluded.append({"path": path, "reason": "gitignored"})
            continue
        if _is_generated(path):
            excluded.append({"path": path, "reason": "generated"})
            continue
        # Starter side reads from old_path on a rename so the "before" is the
        # file the candidate actually started from, not a non-existent new name.
        starter_path = old_path or path
        starter, s_bin, s_trunc = _file_at(clone_dir, base, starter_path)
        final, f_bin, f_trunc = _file_at(clone_dir, head, path)
        patch = _git(clone_dir, "diff", "-M", base, head, "--", starter_path, path)
        adds, dels = counts.get(path, (None, None))
        files.append({
            "path": path,
            "old_path": old_path,
            "status": status,
            "starter": starter,
            "final": final,
            "starter_binary": s_bin,
            "final_binary": f_bin,
            "truncated": s_trunc or f_trunc,
            "additions": adds,
            "deletions": dels,
            "patch": patch.stdout.decode("utf-8", "replace"),
        })

    # Reassemble the combined patch from the kept per-file patches so it stays
    # consistent with ``files`` (the excluded artefacts are absent from both).
    combined_patch = "".join(f["patch"] for f in files)
    return {
        "session_id": session["id"],
        "challenge_id": session["challenge_id"],
        "branch": session["branch_name"],
        # Which variant the starter was cut from ('main' or 'variant/...').
        "source_ref": session.get("source_ref") or "main",
        "candidate_email": session.get("candidate_email"),
        "status": session.get("status"),
        "submitted_at": session.get("submitted_at"),
        # SHAs of the two sides, so a UI can label/link them; base is the empty
        # tree when no provisioning commit was found.
        "base_sha": base,
        "head_sha": head,
        # One file per changed path with both full contents (for side-by-side)
        # and its unified ``patch`` (for inline rendering).
        "files": files,
        # Paths intentionally left out of the diff, each {path, reason} —
        # reason is 'internal' (.jivahire plumbing), 'gitignored' (matched the
        # repo's .gitignore), or 'generated' (build/dependency artefact).
        # Surfaced so the UI can note them rather than silently drop.
        "excluded": excluded,
        # The combined patch over the kept files — drop straight into a unified
        # diff renderer (e.g. diff2html) for a no-assembly-required view.
        "combined_patch": combined_patch,
    }


@router.get("/sessions/{session_id}/code-diff")
def get_session_code_diff(
    session_id: str, x_admin_token: str = Header(None), org_id: str | None = None
):
    """Starter-variant vs final-submission diff for a session.

    Returns per-file ``starter``/``final`` contents plus unified ``patch`` text
    and a ``combined_patch`` for the whole change set. Admin-gated; scoped to
    ``org_id`` when supplied (a foreign-org session reads as 404). 409 when the
    session has not started (no candidate branch exists yet).
    """
    if x_admin_token != settings.admin_token:
        raise HTTPException(403, "Forbidden")
    rows = query("SELECT * FROM sessions WHERE id = ?", (session_id,))
    if not rows:
        raise HTTPException(404, "Not found")
    session = rows[0]
    # Scope to the caller's org when supplied: a session belonging to another
    # org reads as not-found so existence isn't leaked across tenants (same
    # contract as get_session_detail).
    if org_id is not None and session.get("org_id") != org_id:
        raise HTTPException(404, "Not found")
    if session.get("status") not in _HAS_BRANCH:
        raise HTTPException(409, "Session has not started; no candidate workspace to diff yet.")

    clone_dir = Path(tempfile.mkdtemp(prefix=f"diff-{session_id}-")) / "repo"
    try:
        return build_code_diff(session, clone_dir)
    except (subprocess.SubprocessError, OSError):
        # git clone/diff failed: the branch may be gone on GitHub, the install
        # token couldn't be minted, or the git binary is unavailable. Surface a
        # clean 502 rather than leaking git internals as a 500.
        raise HTTPException(502, "Could not load the candidate workspace for diffing.")
    finally:
        shutil.rmtree(clone_dir.parent, ignore_errors=True)
