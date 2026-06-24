# Setup

Get the Shopping Cart Hook challenge ready to run, then run its tests.

## Requirements

| Tool | Version |
|---|---|
| Node.js | >= 18 |
| npm | bundled with Node 18+ |
| Git | any recent version |

The optional `setup.sh` (macOS/Linux) and `setup.ps1` (Windows) scripts install
a current Node LTS if one is missing, then run `npm install` for you. Every
command they run is also listed below, so you can do it all by hand.

## Install

From this challenge folder:

```bash
npm install
```

This pulls the test tools (vitest + jsdom + testing-library) and React into
`./node_modules`.

## First build

There is no separate build step — this is a library-style hook plus an optional
Vite playground. After `npm install` the code is ready to test and to run. To
sanity-check the toolchain, run the test suite (next section); a green run means
everything is wired up.

To view the optional visual playground in a browser (not graded):

```bash
npm run dev
```

This starts Vite and opens `http://localhost:5173` with a live cart that drives
your `useCart` hook.

## Running tests

Run the whole suite (vitest, single run, jsdom environment):

```bash
npm test
```

Tests are tagged in their titles with `@basic`, `@discount`, `@clamp`, and
`@coupons`. Filter to a single group by passing a `-t` substring:

```bash
npx vitest run -t "@basic"
```

Other groups: `@discount`, `@clamp`, `@coupons`. The package also exposes a
shortcut script for the same thing:

```bash
npm run test:tag "@discount"
```

On the unmodified starter, all `@basic` tests pass and one each of the
`@discount` / `@clamp` / `@coupons` tests fail on purpose — those point at the
three bugs you are here to fix.

> How the grader runs it: `npm install`, then `npx vitest run -t "@<tag>"`,
> where `<tag>` is a substring of a test title (one of basic / discount / clamp /
> coupons).

## Troubleshooting

- **`vitest: command not found` or "Cannot find module".** Dependencies aren't
  installed. Run `npm install` from this folder first, then retry.
- **`npm test` says every test passes (including the intentional failures).**
  You've changed the starter. Restore a fresh copy — on the untouched starter,
  one each of `@discount` / `@clamp` / `@coupons` must fail.
- **Node is too old (vitest errors on startup or unsupported syntax).** Check
  `node --version`; it must be >= 18. Install a current LTS from
  https://nodejs.org (or run `bash setup.sh` / `setup.ps1`) and re-open your
  terminal so the new Node is on your PATH.
- **`npm run dev` won't open / port 5173 busy.** Another Vite server is already
  running. Stop it, or open the URL Vite prints in the terminal manually. The
  playground is optional and never affects your grade.
