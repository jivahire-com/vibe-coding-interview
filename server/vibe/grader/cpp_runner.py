import os
import shutil
import subprocess
from pathlib import Path


def build_and_test(clone_dir: Path, hidden_test_src: Path, tags: list[str]) -> tuple[dict[str, bool], str]:
    """
    Copy hidden tests into clone, build with CMake + TSan, run per-tag.
    Returns (tag_results, raw_output).
    """
    # CMake glob in challenge CMakeLists requires the `.cpp` extension; keep the source name.
    shutil.copy(hidden_test_src, clone_dir / "tests" / hidden_test_src.name)

    output_lines = []

    def run(cmd: list[str], timeout: int, cwd: Path = clone_dir, build_step: bool = False) -> subprocess.CompletedProcess:
        r = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd
        )
        output_lines.append(f"$ {' '.join(cmd)}")
        # For build steps, skip verbose stdout and only keep stderr (compile errors)
        if build_step:
            if r.stderr:
                output_lines.append(r.stderr)
            elif r.returncode != 0:
                output_lines.append(r.stdout[-2000:])  # last 2k of stdout if no stderr
        else:
            output_lines.append(r.stdout)
            if r.stderr:
                output_lines.append(r.stderr)
        return r

    build_dir = clone_dir / "build"
    challenge_build = Path(hidden_test_src).parent.parent / "build" / "_deps"
    run(
        ["cmake", "-B", str(build_dir), "-DCMAKE_BUILD_TYPE=Debug",
         "-DCMAKE_CXX_FLAGS=-fsanitize=thread -fno-omit-frame-pointer",
         f"-DFETCHCONTENT_BASE_DIR={challenge_build.parent}"],
        timeout=90,
        build_step=True,
    )
    result = run(["cmake", "--build", str(build_dir), "-j4"], timeout=180, build_step=True)
    if result.returncode != 0:
        return {}, "\n".join(output_lines)

    test_bin = build_dir / "tests"
    # ASLR entropy on Linux 6.x breaks TSan's shadow-memory layout; setarch -R
    # disables randomization for the child so the sanitizer can map its arenas.
    arch = os.uname().machine
    tag_results: dict[str, bool] = {}
    for tag in tags:
        r = run(["setarch", arch, "-R", str(test_bin), tag], timeout=30)
        tag_results[tag] = r.returncode == 0

    return tag_results, "\n".join(output_lines)
