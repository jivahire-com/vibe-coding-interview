# Thread-Safe LRU Cache (C++17)

You have **~45 minutes** (90-minute hard cap) to deliver a correct, thread-safe,
templated LRU cache. The public API lives in `include/lru_cache.hpp`.

---

## What you must deliver

1. **All public `[basic]` tests pass** — they're already passing on the starter; keep them green.
2. **The cache is thread-safe** under concurrent `get`/`put` from multiple threads.
3. **Edge cases handled correctly**: `capacity=0`, updating an existing key without triggering spurious eviction, move-only value types.

When you submit, additional **hidden tests** run from the same `tests/` directory.
The public tests give you a clear signal about correctness shapes — use them as hints.

---

## How to build and run tests

```bash
# First time only — fetches Catch2 (~10s on first run, cached after)
cmake -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j

# Run all tests
./build/tests

# Run a specific tag group
./build/tests "[basic]"
./build/tests "[thread]"
./build/tests "[edge]"
```

See `SETUP.md` for toolchain requirements.

---

## Using AI (encouraged — we evaluate *how* you use it)

Open the **Vibe AI** panel in the sidebar. Your budget is shown at the top.

We measure:
- **Prompt quality**: are your questions targeted, or do you paste entire files and ask "fix this"?
- **Critical evaluation**: do you test AI-generated code before accepting it?
- **Independence**: do you understand the solution you submit?

Pasting AI output is fine. Pasting it without testing is not.

---

## Submitting

Click **Submit** in the Vibe AI sidebar, or run `Vibe: Submit` from the command palette (`Ctrl+Shift+P`).

Auto-submit fires at the time limit if you forget. Make sure your latest changes are committed
(`git status` should show a clean tree before you submit).

---

## Scoring dimensions (the rubric is hidden, but the dimensions are not)

| Dimension | Weight | What we look at |
|---|---|---|
| Test pass rate | 40% | Which test groups pass (automated) |
| Code quality | 25% | Correctness, edge cases, C++ idioms |
| AI orchestration | 20% | How you used the AI (prompt history in your git log) |
| Architectural reasoning | 15% | Design decisions, trap awareness |
