# Setup

How to install dependencies and run the tests for the **Deep Merge Utility
(TypeScript)** challenge. The code you edit lives in `src/deep_merge.ts`; the
tests live under `tests/`.

## Requirements

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | ≥ 18 | Required by `package.json` `engines`; vitest needs a current runtime. |
| npm | bundled with Node | Used to install dev dependencies (vitest + TypeScript). |
| Git | any recent | To clone / version the challenge. |

The only runtime dependencies are dev tools: `typescript@5.4.5` and
`vitest@1.6.0`, both pulled in by `npm install`.

## Install

From this challenge folder.

### macOS / Linux

```bash
npm install
```

Or use the one-command helper, which installs Node 18+ if it is missing and then
runs `npm install`:

```bash
# macOS / Linux
bash setup.sh

# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File setup.ps1
```

## First build

There is no separate build step — this is a TypeScript source project compiled
on the fly by vitest. To confirm the code typechecks without emitting any
output:

```bash
npm run typecheck      # runs: tsc --noEmit
```

`tsconfig.json` sets `"noEmit": true`, so nothing is written to disk; it only
reports type errors.

## Running tests

Run the whole suite (vitest, single run, verbose):

```bash
npm test
# equivalent to: vitest run --reporter=verbose
# or directly:   npx vitest run
```

Run a single tag group. Test titles end with a tag (`@basic`, `@immutable`,
`@arrays`, `@security`), and `-t` filters by any substring of the test title:

```bash
npx vitest run -t "@basic"
npx vitest run -t "@immutable"
npx vitest run -t "@arrays"
npx vitest run -t "@security"
```

The package also exposes a shortcut for the same thing:

```bash
npm run test:tag "@basic"
```

> Grading note: the grader runs `npm install` followed by
> `npx vitest run -t "@<tag>"`, where `<tag>` is a substring of the test title.

On the **unmodified starter**, all `@basic` tests pass while one each of the
`@immutable`, `@arrays`, and `@security` tests fail on purpose — those failures
point at the three bugs to fix.

## Troubleshooting

**`npm test` fails with a syntax or "Unexpected token" error.**
You are almost certainly on Node < 18. Check with `node --version` and install a
current LTS (`bash setup.sh` will do this for you on macOS/Linux).

**`vitest: command not found` or "Cannot find module 'vitest'".**
Dependencies were not installed in this folder. Run `npm install` from the
challenge root so `node_modules/` is populated, then re-run the tests.

**`npx vitest run -t "@basic"` matches nothing / "No test files found".**
Make sure you run it from the challenge root (where `vitest.config.ts` lives) and
keep the quotes around the tag. The config only collects `tests/**/*.test.ts`,
and `-t` matches against the test title text, so the leading `@` must be
included.
