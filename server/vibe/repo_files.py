"""Recruiter-facing challenge-repo file browser/editor.

Lets an authenticated recruiter (admin token) view and edit the files of any
challenge's GitHub repo from the dashboard. Saving an edit commits to a
`variant/<name>` branch in the same repo (created from `base_ref` on first
save). At invite time the recruiter can then assign a candidate to that variant
branch instead of the original `main` — see `CreateSessionRequest.source_ref`
and `_create_github_branch` in sessions.py.

The `.jivahire/` directory holds the rubric, traps, and hidden tests — the
challenge answer key. It is blocked from both reads and writes here and
filtered out of the file tree so it cannot be viewed or leaked through this
surface. (Note: stripping `.jivahire/` from the candidate's branch at clone
time is a separate, still-unimplemented concern — this guard only covers the
recruiter editor.)
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


def _is_protected(path: str) -> bool:
    """True for the `.jivahire/` answer-key directory, which must never be
    exposed or edited through the recruiter file surface."""
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
        {"path": t["path"], "sha": t["sha"]}
        for t in r.json().get("tree", [])
        if t.get("type") == "blob" and not _is_protected(t["path"])
    ]
    files.sort(key=lambda f: f["path"])
    return {"ref": ref, "files": files}


@router.get("/{challenge_id}/file")
async def get_file(
    challenge_id: str, path: str, ref: str = "main", x_admin_token: str = Header(None)
):
    _check_token(x_admin_token)
    if _is_protected(path):
        raise HTTPException(403, "The .jivahire/ directory cannot be viewed")
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
    return {"path": path, "ref": ref, "sha": data["sha"], "content": content}


class SaveRequest(BaseModel):
    branch: str
    path: str
    content: str
    # Blob sha of the file being overwritten on `branch` (required by GitHub to
    # update an existing file; omit when creating a new file).
    sha: str | None = None
    # Ref the variant branch is cut from if it doesn't exist yet.
    base_ref: str = "main"
    message: str | None = None


@router.post("/{challenge_id}/save")
async def save_file(challenge_id: str, req: SaveRequest, x_admin_token: str = Header(None)):
    _check_token(x_admin_token)
    if _is_protected(req.path):
        raise HTTPException(403, "The .jivahire/ directory cannot be edited")
    branch = req.branch.strip()
    # Writes are confined to the `variant/*` namespace: never `main` (the
    # pristine challenge) and never a candidate `interview/*` branch.
    if not branch.startswith("variant/") or branch == "variant/":
        raise HTTPException(400, "branch must be a non-empty 'variant/...' name")
    repo = _repo(challenge_id)
    # Create the variant branch from base_ref if it doesn't exist yet; a 422
    # (branch already exists) is tolerated inside _create_github_branch.
    await _create_github_branch(repo, branch, source_ref=req.base_ref)
    headers = await _gh_headers(repo)
    body = {
        "message": req.message or f"recruiter edit: {req.path}",
        "content": base64.b64encode(req.content.encode("utf-8")).decode("ascii"),
        "branch": branch,
    }
    if req.sha:
        body["sha"] = req.sha
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.put(
            f"{_GH}/repos/{repo}/contents/{req.path}", headers=headers, json=body
        )
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
