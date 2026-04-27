import shutil
import subprocess
from pathlib import Path


def build_and_test(clone_dir: Path, hidden_test_src: Path) -> tuple[dict[str, bool], str]:
    """
    Copy hidden tests into clone, build with CMake + TSan, run per-tag.
    Returns (tag_results, raw_output).
    """
    shutil.copy(hidden_test_src, clone_dir / "tests" / "hidden_test.cpp")

    output_lines = []

    def run(cmd: list[str], timeout: int, cwd: Path = clone_dir) -> subprocess.CompletedProcess:
        r = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd
        )
        output_lines.append(f"$ {' '.join(cmd)}")
        output_lines.append(r.stdout)
        if r.stderr:
            output_lines.append(r.stderr)
        return r

    build_dir = clone_dir / "build"
    run(
        ["cmake", "-B", str(build_dir), "-DCMAKE_BUILD_TYPE=Debug",
         "-DCMAKE_CXX_FLAGS=-fsanitize=thread -fno-omit-frame-pointer"],
        timeout=90,
    )
    result = run(["cmake", "--build", str(build_dir), "-j1"], timeout=180)
    if result.returncode != 0:
        return {}, "\n".join(output_lines)

    test_bin = build_dir / "tests"
    tag_results: dict[str, bool] = {}
    for tag in ["[basic]", "[thread]", "[edge]"]:
        r = run([str(test_bin), tag], timeout=30)
        tag_results[tag] = r.returncode == 0

    return tag_results, "\n".join(output_lines)
