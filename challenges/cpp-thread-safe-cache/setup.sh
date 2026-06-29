#!/usr/bin/env bash
# =============================================================================
# cpp-thread-safe-cache — one-command setup  (macOS / Linux / WSL)
#
# On Windows, run this inside WSL (Ubuntu) — run `wsl --install` first if you
# don't have it. WSL is how most C++ developers work on Windows, and it matches
# the Linux environment the grader uses.
#
# WHAT THIS IS
#   An optional helper that gets this challenge ready to run. Every command it
#   runs is also written out in the README under "Build & run" — so if you would
#   rather do it by hand, you can. Nothing here is hidden or destructive.
#
# WHAT IT DOES
#   1. Checks for CMake 3.14+ and a C++17 compiler. If either is missing, it
#      installs them with your system's package manager (Homebrew on macOS;
#      apt / dnf / pacman on Linux).
#   2. Configures and builds the project into ./build. The first build also
#      downloads and compiles Catch2 (the test framework) — that one-time step
#      is the slow part; later rebuilds are fast.
#
# WHAT IT MIGHT ASK FOR
#   Installing a *missing* toolchain on Linux may prompt for your password
#   (sudo). On macOS, the C++ compiler comes from the Xcode Command Line Tools,
#   which may pop up a system install dialog the first time.
#
# HOW TO RUN
#   bash setup.sh
#
# WHEN IT FINISHES
#   ./build/tests
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"   # run from this challenge folder, wherever it was invoked

have_compiler() {
  command -v c++ >/dev/null 2>&1 || command -v g++ >/dev/null 2>&1 || command -v clang++ >/dev/null 2>&1
}

install_toolchain() {
  echo "CMake and/or a C++17 compiler not found — installing them..."
  if [[ "${OSTYPE:-}" == darwin* ]]; then
    # The compiler ships with Xcode Command Line Tools; CMake comes from brew.
    xcode-select -p >/dev/null 2>&1 || xcode-select --install || true
    if command -v brew >/dev/null 2>&1; then
      brew install cmake
    else
      echo "ERROR: Homebrew not found. Install it from https://brew.sh and re-run,"
      echo "       or install CMake from https://cmake.org/download."
      exit 1
    fi
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y cmake build-essential
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y cmake gcc-c++ make
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --noconfirm cmake gcc make
  else
    echo "ERROR: No supported package manager found. Install CMake 3.14+ and a"
    echo "       C++17 compiler (GCC 11+ or Clang 14+), then re-run this script."
    exit 1
  fi
}

if ! command -v cmake >/dev/null 2>&1 || ! have_compiler; then
  install_toolchain
  if ! command -v cmake >/dev/null 2>&1 || ! have_compiler; then
    echo "ERROR: Toolchain still incomplete after install. Please install CMake 3.14+"
    echo "       and a C++17 compiler manually, then re-run."
    exit 1
  fi
fi
echo "Using $(cmake --version | head -1)"

# First build also fetches + compiles Catch2 (one-time, then cached in build/_deps).
cmake -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j

cat <<'DONE'

------------------------------------------------------------
Setup complete. Run the tests with:

  ./build/tests

On the unmodified starter, most tests pass but the "LRU eviction order"
[basic] test fails on purpose — that points at the bug you start with.
After you edit the header, rebuild and re-run:

  cmake --build build -j && ./build/tests
------------------------------------------------------------
DONE
