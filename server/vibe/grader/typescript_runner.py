"""TypeScript grader backend.

Vitest is the test framework. Tag selection works via `-t "@<tag>"` which filters
by substring match against the full test name (describe > test). Each tag is run
in its own subprocess so a hang in one test group cannot stall the others.

Per-tag pass/fail is determined by the vitest exit code:
  - 0  → all matched tests passed (or none matched — but the authoring guide
        §6 requires every declared tag to have ≥ 1 hidden test, so we treat
        "no matches" as an author bug, not a candidate pass).
  - !0 → at least one matched test failed, or the test files failed to load
        (syntax error, type error from candidate edits, etc.).

The npm install step is heavy (~10–30 s on a warm cache, ~60 s cold). We give it
a generous timeout but fail closed if it does not complete: a failed install
yields an empty tag_results dict, which the composite scorer treats as
test_score = 0 and trap_score = 0 for missing detection tags.
"""

import re
import shutil
import subprocess
from pathlib import Path

_INSTALL_TIMEOUT_S = 240
_TEST_TIMEOUT_S = 60
_NPM_INSTALL_FLAGS = [
    "--no-audit",
    "--no-fund",
    "--prefer-offline",
    "--loglevel=error",
]


def build_and_test(
    clone_dir: Path, hidden_test_src: Path, tags: list[str]
) -> tuple[dict[str, bool], str]:
    """Copy hidden test in, install deps, run vitest once per tag.

    Returns (tag_results, raw_output). On install failure, tag_results is empty.
    """
    dest = clone_dir / "tests" / hidden_test_src.name
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(hidden_test_src, dest)

    output_lines: list[str] = []

    def run(
        cmd: list[str], timeout: int, capture_truncate: int | None = None
    ) -> subprocess.CompletedProcess:
        try:
            r = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=clone_dir,
                check=False,
            )
        except subprocess.TimeoutExpired as e:
            output_lines.append(f"$ {' '.join(cmd)}  # TIMEOUT after {timeout}s")
            stdout = (e.stdout or b"").decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
            stderr = (e.stderr or b"").decode("utf-8", "replace") if isinstance(e.stderr, bytes) else (e.stderr or "")
            if capture_truncate is not None:
                stdout = stdout[-capture_truncate:]
                stderr = stderr[-capture_truncate:]
            output_lines.append(stdout)
            if stderr:
                output_lines.append(stderr)
            return subprocess.CompletedProcess(cmd, returncode=124, stdout=stdout, stderr=stderr)

        output_lines.append(f"$ {' '.join(cmd)}")
        stdout = r.stdout
        stderr = r.stderr
        if capture_truncate is not None:
            stdout = stdout[-capture_truncate:]
            stderr = stderr[-capture_truncate:]
        output_lines.append(stdout)
        if stderr:
            output_lines.append(stderr)
        return r

    if not (clone_dir / "package.json").exists():
        output_lines.append("FATAL: package.json missing — not a TypeScript challenge clone")
        return {}, "\n".join(output_lines)

    install = run(
        ["npm", "install", *_NPM_INSTALL_FLAGS],
        timeout=_INSTALL_TIMEOUT_S,
        capture_truncate=4_000,
    )
    if install.returncode != 0:
        return {}, "\n".join(output_lines)

    tag_results: dict[str, bool] = {}
    for tag in tags:
        sanitized = _sanitize_tag(tag)
        r = run(
            ["npx", "--no-install", "vitest", "run", "-t", f"@{sanitized}"],
            timeout=_TEST_TIMEOUT_S,
            capture_truncate=8_000,
        )
        # Vitest passes with exit 0 when zero tests match the filter. Guard
        # against that: if stdout has no "Tests" summary line indicating any
        # tests ran, treat the tag as failed.
        ran_any = _vitest_ran_any_test(r.stdout)
        tag_results[tag] = r.returncode == 0 and ran_any

    return tag_results, "\n".join(output_lines)


_ALLOWED_TAG_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")


def _sanitize_tag(tag: str) -> str:
    """Strip anything that could break the shell or vitest regex parsing.

    Tag names per CHALLENGE_AUTHORING.md §6 are kebab-case/word characters only,
    but we defend in depth so a malicious metadata file cannot inject flags.
    """
    return "".join(c for c in tag if c in _ALLOWED_TAG_CHARS)[:64]


def _vitest_ran_any_test(stdout: str) -> bool:
    """True if vitest actually executed (passed or failed) at least one test.

    Vitest summary line variants:
      - "Tests  7 passed | 19 skipped (26)"  → ran 7
      - "Tests  3 failed | 3 passed | 20 skipped (26)"  → ran 6
      - "Tests  26 skipped (26)"  → tag filter matched nothing
      - "Tests  no tests"  → no test files

    We require a non-zero pass *or* fail count. "Skipped" alone is treated as
    no matches — which is the author bug case the §6 closure rules guard
    against; we fail closed to surface it instead of silently giving credit.
    """
    pattern = re.compile(r"(\d+)\s+(passed|failed)\b", re.IGNORECASE)
    for line in stdout.splitlines():
        s = line.strip()
        if not s.startswith("Tests"):
            continue
        for count_str, _kind in pattern.findall(s):
            if int(count_str) > 0:
                return True
        return False
    return False


# Exposed for unit tests in the grader test suite.
__all__ = ["build_and_test"]
