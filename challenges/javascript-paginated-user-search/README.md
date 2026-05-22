# Paginated User List with Debounced Search (JavaScript)

You have **~60 minutes** to deliver a correct, tightly
scoped controller for a paginated user list with debounced search. The public
API lives in [src/user_search.js](src/user_search.js).

---

## The Task

A working skeleton of `UserSearch` is provided. It runs, fetches users,
notifies subscribers, and the simplest happy paths already pass. The
implementation contains planted bugs in:

- **the debounce** — what it closes over at scheduling time vs. what should be
  read when the timer fires,
- **overlapping fetches** — when an older request resolves after a newer one,
  the result that wins is the wrong one,
- **the totalPages math** — a trailing partial page is unreachable from the UI.

Read the failing public tests — they point at the bugs without naming them.

## What you must deliver

1. **All public tests pass.** A few fail on the starter as hints — fix the root
   cause, not just the failing assertion.
2. **The debounced fetch reflects the user's current page and current query at
   the moment it fires**, not at the moment it was scheduled.
3. **Out-of-order fetch responses cannot overwrite fresh state.** A slow,
   superseded request must be discarded on resolve.
4. **`totalPages` includes the trailing partial page.** Page 3 of 11 users at
   pageSize 5 must be reachable.
5. **The public API surface stays the same** — `setQuery`, `setPage`,
   `subscribe`, `getState`, and `dispose` are part of the contract.

The hidden test suite — run by the grader — covers stale-closure scenarios
(multiple page changes inside one debounce window), out-of-order resolutions
across both queries and pages, edge cases for the page parameter, and trailing
behaviour of the loading flag.

---

## How to run tests

```bash
# First time only
npm install

# All tests (vitest)
npm test

# Filter by tag — test names end with @basic / @stale / @race / @pagination
npm run test:tag "@basic"
npm run test:tag "@stale"
npm run test:tag "@race"
npm run test:tag "@pagination"
```

See [SETUP.md](SETUP.md) for toolchain requirements and troubleshooting.

---

## Using AI (encouraged — we evaluate *how* you use it)

Open the **Vibe AI** panel in the sidebar. Your budget is shown at the top.

We measure:
- **Prompt quality** — targeted questions vs. paste-the-file-and-ask-fix.
- **Critical evaluation** — testing AI output before accepting it.
- **Independence** — understanding the solution you submit.

Pasting AI output is fine. Pasting it without testing is not.

---

## Submitting

Click **Submit** in the Vibe AI sidebar, or run `Vibe: Submit` from the command
palette (`Ctrl+Shift+P`).

Auto-submit fires at the time limit if you forget. Make sure your latest
changes are committed (`git status` should show a clean tree before you
submit).

---

## Scoring dimensions

| Dimension | Weight | What we look at |
|---|---|---|
| Test pass rate | 20% | Which tag groups pass (automated) |
| Trap detection | 10% | Whether you found and fixed the planted bugs |
| Code quality | 20% | Correctness, edge cases, JavaScript idioms |
| Prompt quality | 15% | How precisely you brief the AI |
| AI orchestration | 15% | Strategic use vs. blind copy-paste |
| Architectural reasoning | 10% | Design decisions you made (not ones inherited from the starter) |
| Token efficiency | 10% | Proportionate use of the AI token budget |
