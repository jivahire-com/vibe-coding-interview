#!/usr/bin/env bash
# =============================================================================
# react-shopping-cart — one-command setup  (macOS / Linux)
#
# WHAT THIS IS
#   An optional helper that gets this challenge ready to run. Every command it
#   runs is also written out in the README under "How to run tests" — so if you
#   would rather do it by hand, you can. Nothing here is hidden or destructive.
#
# WHAT IT DOES
#   1. Checks for Node.js 18+. If it is missing, it installs a current LTS with
#      your system's package manager (Homebrew on macOS; NodeSource/apt, dnf,
#      or pacman on Linux).
#   2. Runs `npm install` to pull this challenge's test tools (vitest + jsdom +
#      testing-library) into ./node_modules.
#
# WHAT IT MIGHT ASK FOR
#   Installing a *missing* Node on Linux may prompt for your password (sudo).
#   If Node 18+ is already on your machine, nothing is installed.
#
# HOW TO RUN
#   bash setup.sh
#
# WHEN IT FINISHES
#   npm test
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"   # run from this challenge folder, wherever it was invoked

have_node() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$major" -ge 18 ]
}

install_node() {
  echo "Node.js 18+ not found — installing it..."
  if [[ "${OSTYPE:-}" == darwin* ]]; then
    if command -v brew >/dev/null 2>&1; then
      brew install node@20
    else
      echo "ERROR: Homebrew not found. Install it from https://brew.sh and re-run,"
      echo "       or install Node 20 LTS from https://nodejs.org."
      exit 1
    fi
  elif command -v apt-get >/dev/null 2>&1; then
    # NodeSource gives a current LTS; the distro package is often too old for vitest.
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y nodejs
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --noconfirm nodejs npm
  else
    echo "ERROR: No supported package manager found. Install Node 18+ from"
    echo "       https://nodejs.org and re-run this script."
    exit 1
  fi
}

if ! have_node; then
  install_node
  if ! have_node; then
    echo "ERROR: Node 18+ still not found after install. Please install it manually."
    exit 1
  fi
fi
echo "Using node $(node --version) / npm $(npm --version)"

npm install

cat <<'DONE'

------------------------------------------------------------
Setup complete. Run the tests with:

  npm test

On the unmodified starter, the @basic tests pass and one each of the
@discount / @clamp / @coupons tests fail on purpose — those point at the
bugs you are here to fix.

Optional: launch the visual playground (not graded) to click through your
cart in a browser:

  npm run dev
------------------------------------------------------------
DONE
