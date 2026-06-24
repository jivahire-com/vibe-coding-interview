#!/usr/bin/env bash
# =============================================================================
# python-money — one-command setup  (macOS / Linux)
#
# WHAT THIS IS
#   An optional helper that gets this challenge ready to run. Every command it
#   runs is also written out in the README under "How to run tests" — so if you
#   would rather do it by hand, you can. Nothing here is hidden or destructive.
#
# WHAT IT DOES
#   1. Checks for Python 3.11+. If it is missing, it installs it with your
#      system's package manager (Homebrew on macOS; apt / dnf / pacman on Linux).
#   2. Creates an isolated virtual environment in ./.venv — this does NOT touch
#      your system Python.
#   3. Installs this project's test tool (pytest) into that .venv.
#
# WHAT IT MIGHT ASK FOR
#   Installing a *missing* Python on Linux may prompt for your password (sudo).
#   If Python 3.11+ is already on your machine, nothing is installed.
#
# HOW TO RUN
#   bash setup.sh
#
# WHEN IT FINISHES
#   source .venv/bin/activate
#   pytest
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"   # run from this challenge folder, wherever it was invoked

# Print the first python3.11+ interpreter found, or nothing.
find_python() {
  for c in python3.13 python3.12 python3.11 python3; do
    if command -v "$c" >/dev/null 2>&1; then
      local v major minor
      v=$("$c" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || echo "0.0")
      major=${v%%.*}; minor=${v#*.}
      if [ "$major" -eq 3 ] && [ "$minor" -ge 11 ]; then echo "$c"; return 0; fi
    fi
  done
  return 1
}

install_python() {
  echo "Python 3.11+ not found — installing it..."
  if [[ "${OSTYPE:-}" == darwin* ]]; then
    if command -v brew >/dev/null 2>&1; then
      brew install python@3.11
    else
      echo "ERROR: Homebrew not found. Install it from https://brew.sh and re-run,"
      echo "       or install Python 3.11+ from https://python.org/downloads."
      exit 1
    fi
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y python3.11 python3.11-venv python3-pip \
      || sudo apt-get install -y python3 python3-venv python3-pip
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y python3 python3-pip
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --noconfirm python python-pip
  else
    echo "ERROR: No supported package manager found. Install Python 3.11+ from"
    echo "       https://python.org/downloads and re-run this script."
    exit 1
  fi
}

PY=$(find_python || true)
if [ -z "${PY:-}" ]; then
  install_python
  PY=$(find_python || true)
  if [ -z "${PY:-}" ]; then
    echo "ERROR: Python 3.11+ still not found after install. Please install it manually."
    exit 1
  fi
fi
echo "Using $PY ($("$PY" --version))"

# Isolated environment so the challenge's deps never touch your system Python.
if [ ! -d .venv ]; then
  "$PY" -m venv .venv
fi
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -e ".[dev]"

cat <<'DONE'

------------------------------------------------------------
Setup complete. Run the tests with:

  source .venv/bin/activate
  pytest

On the unmodified starter, the basic tests pass and one each of the
rounding / currency / allocate tests fail on purpose — those point at
the bugs you are here to fix.
------------------------------------------------------------
DONE
