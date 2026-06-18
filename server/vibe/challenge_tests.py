"""Recruiter-facing access to a challenge's test files.

Two concerns, kept deliberately separate from the session-detail payload so the
heavy test source never rides along with every poll of a session:

  * `GET /api/v1/challenges/{cid}/tests` — a **code-free** catalogue: every test
    case with its name, Catch2 tags, visibility (public vs hidden) and a short
    one-line docstring (the `// @doc:` comment authored above each `TEST_CASE`),
    plus the planted traps. Cheap to fetch; safe to show in a list.
  * `GET /api/v1/challenges/{cid}/tests/code` — the **actual test source** of the
    public and hidden test files. This is what a recruiter opens on demand from
    the session-details "View tests" panel; it is intentionally NOT part of
    `GET /sessions/{id}`.

Both read the files off the local challenges checkout (same on-disk source the
grader builds from — see `settings.challenges_dir`), resolving the public/hidden
file paths from the challenge's `.jivahire/metadata.json`. Admin-token gated, the
same trust boundary as the rest of the recruiter dashboard: hidden tests are part
of the answer key and must never reach a candidate, but a recruiter reviewing a
graded session needs to see exactly what was checked.
"""

import json
import os
import re

from fastapi import APIRouter, Header, HTTPException, Query

from vibe.config import settings

router = APIRouter(prefix="/api/v1/challenges")

# A `// @doc:` (or `# @doc:`) comment authored directly above a test case. The
# text after the marker is the short, human description we surface in the UI.
_DOC_RE = re.compile(r"@doc:\s*(.+?)\s*$")

# Catch2 declaration: TEST_CASE("name", "[tag1][tag2]"). The tag string is
# optional in Catch2, so the second argument is matched lazily.
_CPP_CASE_RE = re.compile(r'TEST_CASE\s*\(\s*"((?:[^"\\]|\\.)*)"\s*(?:,\s*"((?:[^"\\]|\\.)*)")?')

# pytest-style `def test_*` and JS/TS `it("...")` / `test("...")` declarations,
# so the catalogue degrades gracefully for the non-C++ challenges. C++ is the
# only language currently offered to recruiters, but the parser stays generic.
_PY_CASE_RE = re.compile(r"def\s+(test_\w+)\s*\(")
_JS_CASE_RE = re.compile(r'\b(?:it|test)\s*\(\s*[\'"`]([^\'"`]+)[\'"`]')

_TAG_RE = re.compile(r"\[([^\]]+)\]")


def _parse_cases(source: str, language: str) -> list[dict]:
    """Extract `{name, tags, doc}` for every test case in `source`.

    `doc` is the nearest preceding `@doc:` comment (empty string if the author
    didn't write one). `tags` is the list of Catch2 tags for C++ (e.g.
    `["basic"]`); empty for languages without a tag convention.
    """
    cases: list[dict] = []
    pending_doc = ""
    for line in source.splitlines():
        m = _DOC_RE.search(line)
        if m:
            pending_doc = m.group(1)
            continue

        name: str | None = None
        tags: list[str] = []
        if language == "cpp":
            cm = _CPP_CASE_RE.search(line)
            if cm:
                name = cm.group(1)
                tags = _TAG_RE.findall(cm.group(2) or "")
        elif language == "python":
            pm = _PY_CASE_RE.search(line)
            if pm:
                name = pm.group(1)
        else:  # javascript / typescript
            jm = _JS_CASE_RE.search(line)
            if jm:
                name = jm.group(1)

        if name is not None:
            cases.append({"name": name, "tags": tags, "doc": pending_doc})
            pending_doc = ""
    return cases


def _challenge_meta(challenge_id: str) -> dict:
    """Read a challenge's `.jivahire/metadata.json`, or raise 404 if the
    challenge directory has no metadata (unknown/misconfigured challenge)."""
    path = os.path.join(
        settings.challenges_dir, challenge_id, ".jivahire", "metadata.json"
    )
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        raise HTTPException(404, f"Unknown challenge '{challenge_id}'")
    except (OSError, ValueError):
        return {}


def _read_test_file(challenge_id: str, rel_path: str) -> str | None:
    """Read a test file given its challenge-root-relative path from metadata.
    Returns None when the field is absent or the file can't be read — the test
    catalogue is descriptive, so a missing file yields no cases rather than 500.
    The path is confined to the challenge directory; traversal is rejected."""
    if not rel_path:
        return None
    base = os.path.realpath(os.path.join(settings.challenges_dir, challenge_id))
    full = os.path.realpath(os.path.join(base, rel_path))
    if full != base and not full.startswith(base + os.sep):
        return None
    try:
        with open(full, "r", encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return None


# (visibility, metadata field holding the challenge-root-relative path).
_TEST_FILES = (
    ("public", "public_test_file"),
    ("hidden", "hidden_test_file"),
)


def _load_traps(challenge_id: str) -> list[dict]:
    """Planted traps as `{id, description}` — the short `summary` is the trap's
    docstring, falling back to the full `description`. Code-free."""
    path = os.path.join(settings.challenges_dir, challenge_id, ".jivahire", "traps.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    out: list[dict] = []
    for trap in data.get("traps", []):
        tid = trap.get("id")
        if not tid:
            continue
        out.append({
            "id": tid,
            "description": trap.get("summary") or trap.get("description") or "",
            "detection_tag": trap.get("detection_tag"),
        })
    return out


def load_test_catalog(challenge_id: str) -> dict:
    """Code-free catalogue: every test case (name, tags, visibility, docstring)
    grouped by visibility, plus the planted traps. The basis for the
    `GET .../tests` endpoint and reusable wherever a code-free list is wanted."""
    meta = _challenge_meta(challenge_id)
    language = meta.get("language") or "unknown"
    tests: list[dict] = []
    for visibility, field in _TEST_FILES:
        source = _read_test_file(challenge_id, meta.get(field))
        if source is None:
            continue
        for case in _parse_cases(source, language):
            tests.append({**case, "visibility": visibility})
    return {
        "challenge_id": challenge_id,
        "language": language,
        "tests": tests,
        "traps": _load_traps(challenge_id),
    }


def load_test_code(challenge_id: str, visibility: str | None = None) -> dict:
    """The actual test source for the public and/or hidden test files, each with
    its parsed per-case docstrings. `visibility` filters to one of public/hidden;
    None returns both."""
    meta = _challenge_meta(challenge_id)
    language = meta.get("language") or "unknown"
    code_fence = meta.get("code_fence") or language
    files: list[dict] = []
    for vis, field in _TEST_FILES:
        if visibility and vis != visibility:
            continue
        rel_path = meta.get(field)
        source = _read_test_file(challenge_id, rel_path)
        if source is None:
            continue
        files.append({
            "visibility": vis,
            "path": rel_path,
            "filename": os.path.basename(rel_path),
            "language": language,
            "code_fence": code_fence,
            "code": source,
            "cases": _parse_cases(source, language),
        })
    return {"challenge_id": challenge_id, "language": language, "files": files}


def _check_admin(x_admin_token: str | None) -> None:
    if x_admin_token != settings.admin_token:
        raise HTTPException(403, "Forbidden")


@router.get("/{challenge_id}/tests")
def get_challenge_tests(challenge_id: str, x_admin_token: str = Header(None)):
    """Code-free catalogue of a challenge's test cases and traps.

    Each test carries `{name, tags, visibility, doc}` (the `doc` is the authored
    `@doc:` one-liner); each trap `{id, description, detection_tag}`. No test
    source — call `.../tests/code` for that.
    """
    _check_admin(x_admin_token)
    return load_test_catalog(challenge_id)


@router.get("/{challenge_id}/tests/code")
def get_challenge_test_code(
    challenge_id: str,
    visibility: str | None = Query(
        None, description="Limit to one of 'public' or 'hidden'; omit for both."
    ),
    x_admin_token: str = Header(None),
):
    """The actual public/hidden test source for a challenge.

    Returns one entry per test file with its raw `code`, the `code_fence` to
    render it under, and the parsed per-case docstrings. Optionally filter to a
    single `visibility`. Admin-gated — hidden tests are answer-key material.
    """
    _check_admin(x_admin_token)
    if visibility is not None and visibility not in ("public", "hidden"):
        raise HTTPException(400, "visibility must be 'public' or 'hidden'")
    return load_test_code(challenge_id, visibility)
