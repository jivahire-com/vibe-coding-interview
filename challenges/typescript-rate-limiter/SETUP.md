# Setup

## Requirements

| Tool | Minimum version | Check |
|---|---|---|
| Node.js | 18 LTS | `node --version` |
| npm | bundled with Node | `npm --version` |
| Git | any | `git --version` |

**No other installs needed.** `vitest` and `typescript` are dev deps, pulled by `npm install`.

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

Expected output on the unmodified starter: most `@basic` and `@edge`
tests pass; one `@refill` test (`refill does not exceed capacity after long
idle`) fails — that failure is intentional and points at a planted bug in
`refill()`.

## Running tests

```bash
# All tests
npm test

# A single tag group (vitest filters by test name)
npm run test:tag "@basic"
npm run test:tag "@refill"
npm run test:tag "@concurrent"
npm run test:tag "@edge"
```

## Troubleshooting

**Problem:** `node: command not found`
**Fix:** macOS `brew install node@20`; Ubuntu `sudo apt-get install nodejs npm`; or install nvm and `nvm install 20`.

**Problem:** `Cannot find module 'vitest'`
**Fix:** You probably skipped `npm install`. Run it from the challenge root and retry.

**Problem:** `Error: EACCES` during `npm install`
**Fix:** Don't run npm with sudo. Either use nvm to install Node into your home directory, or fix the permissions on the npm prefix (`npm config get prefix`).

**Problem:** Tests hang and never finish
**Fix:** That is the symptom of one of the planted bugs. The grader runs every test with a 10 s timeout — your fix should also resolve or reject inside that budget, not hang.

**Problem:** TypeScript / type errors during `npm test`
**Fix:** vitest reports type errors from your changes. Run `npx tsc --noEmit` to see the full error list, then fix in `src/rate_limiter.ts`.
