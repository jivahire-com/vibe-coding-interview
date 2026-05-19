# Setup

## Requirements

| Tool | Minimum version | Check |
|---|---|---|
| Node.js | 18 LTS | `node --version` |
| npm | bundled with Node | `npm --version` |
| Git | any | `git --version` |

**No other installs needed.** `vitest` is pulled by `npm install`.

## Install

**macOS**
```bash
brew install node@20
```

**Linux (Debian/Ubuntu)**
```bash
sudo apt-get update && sudo apt-get install -y nodejs npm
# Or use nvm: https://github.com/nvm-sh/nvm
```

## First build

```bash
npm install
npm test
```

Expected output on the unmodified starter: all `@basic` tests pass; one
`@stale`, one `@race`, and one `@pagination` test fail. Those failures are
intentional and point at the planted bugs.

## Running tests

```bash
# All tests
npm test

# A single tag group (vitest filters by test name substring)
npm run test:tag "@basic"
npm run test:tag "@stale"
npm run test:tag "@race"
npm run test:tag "@pagination"
```

## Troubleshooting

**Problem:** `node: command not found`
**Fix:** macOS `brew install node@20`; Ubuntu `sudo apt-get install nodejs npm`; or install nvm and `nvm install 20`.

**Problem:** `Cannot find module 'vitest'`
**Fix:** You probably skipped `npm install`. Run it from the challenge root and retry.

**Problem:** `Error: EACCES` during `npm install`
**Fix:** Don't run npm with sudo. Either use nvm to install Node into your home directory, or fix the permissions on the npm prefix (`npm config get prefix`).

**Problem:** A test reports `Timed out in 10000ms`
**Fix:** Your fix likely awaits a Promise that never resolves. Check the
debounce / fetch wiring — the grader applies the same 10 s per-test cap.

**Problem:** `SyntaxError: Cannot use import statement outside a module`
**Fix:** The starter uses ES modules; `package.json` already sets
`"type": "module"`. Don't change that — fix imports inside `src/user_search.js`
to use `import`/`export` syntax.
