# Per-Key Token-Bucket Rate Limiter (TypeScript)

You have **~60 minutes** (90-minute hard cap) to deliver a correct,
production-quality token-bucket rate limiter keyed by user id / IP / route.
The public API lives in [src/rate_limiter.ts](src/rate_limiter.ts).

---

## The Task

A working skeleton of `RateLimiter` is provided. It compiles cleanly and the
simplest happy paths already pass. The implementation contains planted bugs in:

- the cap on refill (tokens can overflow `capacity` after long idle),
- constructor input validation (zero / negative / NaN values are silently accepted),
- the async slow path of `acquire()` (it can hang forever in one configuration).

Read the failing public tests — they point at the bugs without naming them.

## What you must deliver

1. **All public tests pass.** A few fail on the starter and serve as hints; fix the root cause, not just the failing assertion.
2. **`refill()` never exceeds `capacity`.** Bursts after long idle stay bounded.
3. **Constructor validates its inputs.** Zero/negative/NaN/Infinity for `capacity` or `refillPerSec` throws a clear error.
4. **`acquire()` is deterministic.** No infinite loops, no busy-waits. Decide and document what happens when `refillPerSec === 0` and the request cannot be satisfied immediately.
5. **Per-key isolation, idle eviction, and `reset/clear/size`** continue to work.

The hidden test suite — run by the grader — covers concurrent acquires on the
same key, refill-rate math under fake clocks, idle eviction, and every planted
trap.

---

## How to run tests

```bash
# First time only
npm install

# All tests (vitest)
npm test

# Filter by tag — test names end with @basic / @refill / @concurrent / @edge
npm run test:tag "@basic"
npm run test:tag "@refill"
npm run test:tag "@concurrent"
npm run test:tag "@edge"
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

Auto-submit fires at the time limit if you forget. Make sure your latest changes
are committed (`git status` should show a clean tree before you submit).

---

## Scoring dimensions

| Dimension | Weight | What we look at |
|---|---|---|
| Test pass rate | 20% | Which tag groups pass (automated) |
| Trap detection | 10% | Whether you found and fixed the planted bugs |
| Code quality | 20% | Correctness, edge cases, TypeScript idioms |
| Prompt quality | 15% | How precisely you brief the AI |
| AI orchestration | 15% | Strategic use vs. blind copy-paste |
| Architectural reasoning | 10% | Design decisions you made (not ones inherited from the starter) |
| Token efficiency | 10% | Proportionate use of the AI token budget |
