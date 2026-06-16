"""Push the server-side `.jivahire/` answer-key files to a challenge repo's
`main` branch so the recruiter file browser can surface them (read-only).

The grader reads rubric/traps off the local `challenges/<id>/.jivahire/` dir, so
these files historically never lived in GitHub. Committing them to `main` makes
them viewable in the recruiter editor. This is safe: candidate `interview/*`
branches are provisioned by `_provision_candidate_branch`, which strips every
`.jivahire/*` blob except `metadata.json`, so the answer key never reaches a
candidate clone.

New `variant/*` branches cut from `main` after this runs inherit the files
automatically; existing variants (cut from the old `main`) are backfilled with
`--variants` so the recruiter editor shows the same read-only answer key there.

Usage (inside the backend container, which has the GitHub App creds):
    uv run python scripts/push_jivahire_to_main.py cpp-thread-safe-cache
    uv run python scripts/push_jivahire_to_main.py --all
    uv run python scripts/push_jivahire_to_main.py --variants cpp-thread-safe-cache
"""

import asyncio
import base64
import os
import sys

import httpx

from vibe.config import repo_for_challenge, settings
from vibe.github_app import mint_installation_token

_GH = "https://api.github.com"
# Answer-key files to publish. token_counts.json (grader cache) and
# telemetry.jsonl (planted per-candidate at clone time) are intentionally left
# out — only the rubric and planted-trap definitions are recruiter-relevant.
_FILES = ["rubric.json", "traps.json"]


async def _headers(repo: str) -> dict:
    token = await mint_installation_token(repo)
    return {
        "Authorization": f"Bearer {token.token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


async def _variant_branches(client: httpx.AsyncClient, repo: str, headers: dict) -> list[str]:
    r = await client.get(f"{_GH}/repos/{repo}/branches?per_page=100", headers=headers)
    if r.status_code != 200:
        raise SystemExit(f"  could not list branches: {r.status_code} {r.text}")
    return [b["name"] for b in r.json() if b["name"].startswith("variant/")]


async def _push_to_branch(
    client: httpx.AsyncClient, repo: str, headers: dict, challenge_id: str, branch: str
) -> None:
    for name in _FILES:
        local = os.path.join(settings.challenges_dir, challenge_id, ".jivahire", name)
        if not os.path.isfile(local):
            print(f"  skip .jivahire/{name}: not present locally")
            continue
        with open(local, "rb") as fh:
            content_b64 = base64.b64encode(fh.read()).decode("ascii")
        path = f".jivahire/{name}"
        # Resolve the live blob sha on the branch (an update needs it; a create
        # must omit it).
        r = await client.get(
            f"{_GH}/repos/{repo}/contents/{path}", headers=headers, params={"ref": branch}
        )
        body = {
            "message": f"publish answer-key file {path} for recruiter view",
            "content": content_b64,
            "branch": branch,
        }
        if r.status_code == 200 and isinstance(r.json(), dict):
            body["sha"] = r.json()["sha"]
        put = await client.put(
            f"{_GH}/repos/{repo}/contents/{path}", headers=headers, json=body
        )
        if put.status_code not in (200, 201):
            raise SystemExit(f"  FAILED {path}@{branch}: {put.status_code} {put.text}")
        print(f"  pushed {path} -> {repo}@{branch}")


async def _push_one(challenge_id: str, include_variants: bool = False) -> None:
    repo = repo_for_challenge(challenge_id)
    headers = await _headers(repo)
    async with httpx.AsyncClient(timeout=20) as client:
        branches = ["main"]
        if include_variants:
            branches += await _variant_branches(client, repo, headers)
        for branch in branches:
            await _push_to_branch(client, repo, headers, challenge_id, branch)


async def _main() -> None:
    args = sys.argv[1:]
    include_variants = False
    if args and args[0] == "--variants":
        include_variants = True
        args = args[1:]
    if args == ["--all"]:
        root = settings.challenges_dir
        challenges = sorted(
            d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d))
        )
    elif args:
        challenges = args
    else:
        raise SystemExit(
            "usage: push_jivahire_to_main.py [--variants] <challenge_id>... | --all"
        )
    for cid in challenges:
        print(f"{cid}:")
        await _push_one(cid, include_variants=include_variants)


if __name__ == "__main__":
    asyncio.run(_main())
