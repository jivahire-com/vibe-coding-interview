import shutil
import subprocess
from pathlib import Path


def build_and_test(clone_dir: Path, hidden_test_src: Path, tags: list[str]) -> tuple[dict[str, bool], str]:
    """
    Copy hidden tests into clone, install in editable mode, run pytest per-tag.
    Returns (tag_results, raw_output).
    """
    dest = clone_dir / "tests" / hidden_test_src.name
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(hidden_test_src, dest)

    output_lines: list[str] = []

    def run(cmd: list[str], timeout: int) -> subprocess.CompletedProcess:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=clone_dir)
        output_lines.append(f"$ {' '.join(cmd)}")
        output_lines.append(r.stdout)
        if r.stderr:
            output_lines.append(r.stderr)
        return r

    install = run(["pip", "install", "-e", ".[dev]"], timeout=180)
    if install.returncode != 0:
        return {}, "\n".join(output_lines)

    tag_results: dict[str, bool] = {}
    for tag in tags:
        r = run(["pytest", "-m", tag, "-q"], timeout=60)
        tag_results[tag] = r.returncode == 0

    return tag_results, "\n".join(output_lines)
