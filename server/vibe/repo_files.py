"""Recruiter-facing challenge-repo file browser/editor.

Lets an authenticated recruiter (admin token) view and edit the files of any
challenge's GitHub repo from the dashboard. Saving an edit commits to a
`variant/<name>` branch in the same repo (created from `base_ref` on first
save). At invite time the recruiter can then assign a candidate to that variant
branch instead of the original `main` — see `CreateSessionRequest.source_ref`
and `_create_github_branch` in sessions.py.

The `.jivahire/` directory holds the rubric, traps, and hidden tests — the
challenge answer key. It is surfaced read-only here: it appears in the file
tree and its files can be read, but writes are rejected so a recruiter can
inspect the answer key without mutating it. Read-only entries are flagged with
`read_only: true` in the tree and file responses. (Keeping the answer key out of
the *candidate's* clone is a separate concern, enforced at branch-creation time
by `sessions._provision_candidate_branch`, which strips every `.jivahire/*` blob
except `metadata.json` from each `interview/*` branch.)
"""

import base64
import logging

import httpx
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from vibe.config import repo_for_challenge, settings
from vibe.github_app import mint_installation_token
from vibe.sessions import _create_github_branch

router = APIRouter(prefix="/api/v1/admin/repos")
log = logging.getLogger("vibe.repo_files")

_GH = "https://api.github.com"


def _check_token(x_admin_token: str | None) -> None:
    if x_admin_token != settings.admin_token:
        raise HTTPException(403, "Forbidden")


def _repo(challenge_id: str) -> str:
    repo = repo_for_challenge(challenge_id)
    if not repo:
        raise HTTPException(500, "Server misconfigured: no challenge repo configured")
    return repo


def _is_read_only(path: str) -> bool:
    """True for the `.jivahire/` answer-key directory, which is readable but must
    never be edited through the recruiter file surface."""
    return path == ".jivahire" or path.startswith(".jivahire/")


async def _gh_headers(repo: str) -> dict:
    """Mint a fresh repo-scoped installation token (contents R/W) and build the
    standard GitHub REST headers — same pattern as sessions._create_github_branch."""
    token = await mint_installation_token(repo)
    return {
        "Authorization": f"Bearer {token.token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


@router.get("/{challenge_id}/branches")
async def list_branches(challenge_id: str, x_admin_token: str = Header(None)):
    _check_token(x_admin_token)
    repo = _repo(challenge_id)
    headers = await _gh_headers(repo)
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(f"{_GH}/repos/{repo}/branches?per_page=100", headers=headers)
    if r.status_code != 200:
        raise HTTPException(502, f"GitHub: could not list branches: {r.text}")
    names = [b["name"] for b in r.json()]
    # Only surface the original challenge + recruiter variants. Candidate
    # `interview/*` branches are private to each session and must not leak here.
    branches = sorted(n for n in names if n == "main" or n.startswith("variant/"))
    return {"branches": branches}


@router.get("/{challenge_id}/tree")
async def get_tree(challenge_id: str, ref: str = "main", x_admin_token: str = Header(None)):
    _check_token(x_admin_token)
    repo = _repo(challenge_id)
    headers = await _gh_headers(repo)
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"{_GH}/repos/{repo}/git/trees/{ref}", headers=headers, params={"recursive": "1"}
        )
    if r.status_code != 200:
        raise HTTPException(502, f"GitHub: could not read tree: {r.text}")
    files = [
        {"path": t["path"], "sha": t["sha"], "read_only": _is_read_only(t["path"])}
        for t in r.json().get("tree", [])
        if t.get("type") == "blob"
    ]
    files.sort(key=lambda f: f["path"])
    return {"ref": ref, "files": files}


@router.get("/{challenge_id}/file")
async def get_file(
    challenge_id: str, path: str, ref: str = "main", x_admin_token: str = Header(None)
):
    _check_token(x_admin_token)
    repo = _repo(challenge_id)
    headers = await _gh_headers(repo)
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"{_GH}/repos/{repo}/contents/{path}", headers=headers, params={"ref": ref}
        )
    if r.status_code == 404:
        raise HTTPException(404, f"File not found: {path}")
    if r.status_code != 200:
        raise HTTPException(502, f"GitHub: could not read file: {r.text}")
    data = r.json()
    if isinstance(data, list) or data.get("type") != "file":
        raise HTTPException(400, f"Not a regular file: {path}")
    content = base64.b64decode(data.get("content", "")).decode("utf-8", errors="replace")
    return {
        "path": path,
        "ref": ref,
        "sha": data["sha"],
        "content": content,
        "read_only": _is_read_only(path),
    }


class SaveRequest(BaseModel):
    branch: str
    path: str
    content: str
    # Blob sha of the file the client believes it is overwriting. Advisory only:
    # the server always resolves the live sha on `branch` itself before writing
    # (the client's value is typically stale — cut from base_ref/main or an
    # earlier load — which is exactly what caused GitHub 409s). Used only as an
    # optimistic-concurrency hint; the resolved live sha wins.
    sha: str | None = None
    # Ref the variant branch is cut from if it doesn't exist yet.
    base_ref: str = "main"
    message: str | None = None


async def _live_blob_sha(client: httpx.AsyncClient, repo: str, headers: dict, path: str, branch: str) -> str | None:
    """Return the current blob sha of `path` on `branch`, or None if the file
    doesn't exist there yet (a create). Always reads from the target branch so
    the sha is correct even when the client cached one from a different ref."""
    r = await client.get(
        f"{_GH}/repos/{repo}/contents/{path}", headers=headers, params={"ref": branch}
    )
    if r.status_code == 404:
        return None
    if r.status_code != 200:
        raise HTTPException(502, f"GitHub: could not read file before save: {r.text}")
    data = r.json()
    if isinstance(data, list) or data.get("type") != "file":
        raise HTTPException(400, f"Not a regular file: {path}")
    return data["sha"]


@router.post("/{challenge_id}/save")
async def save_file(challenge_id: str, req: SaveRequest, x_admin_token: str = Header(None)):
    _check_token(x_admin_token)
    if _is_read_only(req.path):
        raise HTTPException(403, "The .jivahire/ directory is read-only and cannot be edited")
    branch = req.branch.strip()
    # Writes are confined to the `variant/*` namespace: never `main` (the
    # pristine challenge) and never a candidate `interview/*` branch.
    if not branch.startswith("variant/") or branch == "variant/":
        raise HTTPException(400, "branch must be a non-empty 'variant/...' name")
    repo = _repo(challenge_id)
    # Create the variant branch from base_ref if it doesn't exist yet; a 422
    # (branch already exists) is tolerated inside _create_github_branch.
    # provision=False: a variant is a faithful copy of base_ref that KEEPS the
    # `.jivahire/` files (metadata.json, etc.) so they carry into the candidate
    # branch later cut from it. They stay read-only via `_is_read_only` below.
    await _create_github_branch(repo, branch, source_ref=req.base_ref, provision=False)
    headers = await _gh_headers(repo)
    content_b64 = base64.b64encode(req.content.encode("utf-8")).decode("ascii")

    async with httpx.AsyncClient(timeout=20) as client:
        # GitHub's contents API rejects an update whose sha doesn't match the
        # file's *current* blob on the target branch. Resolve that live sha here
        # rather than trusting the (often stale) client sha. One retry covers the
        # narrow race where the ref moves between our GET and the PUT.
        r = None
        for attempt in range(2):
            live_sha = await _live_blob_sha(client, repo, headers, req.path, branch)
            body = {
                "message": req.message or f"recruiter edit: {req.path}",
                "content": content_b64,
                "branch": branch,
            }
            if live_sha:
                body["sha"] = live_sha
            r = await client.put(
                f"{_GH}/repos/{repo}/contents/{req.path}", headers=headers, json=body
            )
            if r.status_code != 409:
                break
    if r.status_code == 409:
        # Still conflicting after a refetch+retry — surface a clean, actionable
        # 409 the recruiter-backend can pass through, not an opaque 502.
        raise HTTPException(409, "File changed on the variant branch; reload and try again")
    if r.status_code not in (200, 201):
        raise HTTPException(502, f"GitHub: could not save file: {r.text}")
    data = r.json()
    log.info(
        "variant_file_saved",
        extra={"context": {"challenge_id": challenge_id, "branch": branch, "path": req.path}},
    )
    return {
        "branch": branch,
        "path": req.path,
        "sha": data.get("content", {}).get("sha"),
        "commit": data.get("commit", {}).get("sha"),
    }
