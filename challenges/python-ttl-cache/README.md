# Thread-Safe TTL Cache (Python 3.11+)

You have **~60 minutes** to deliver a correct, thread-safe,
size-bounded TTL cache. The public API lives in `src/ttl_cache.py`.

---

## What you must deliver

1. **All public `basic` tests pass.** Most pass on the starter; a couple fail and serve as hints pointing at planted bugs you must fix.
2. **The cache is thread-safe** under concurrent `get`/`put` from multiple threads.
3. **TTL is enforced**: `get` must not return entries whose TTL has elapsed.
4. **Edge cases handled correctly**: `capacity=0`, updating an existing key without triggering spurious eviction, no growth beyond `capacity`.

When you submit, additional **hidden tests** run from the same `tests/` directory.
The public tests give you a clear signal about correctness shapes — use them as hints.

---

## How to run tests

```bash
# First time only — install dev deps into a venv
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

# Run all tests
pytest

# Run a specific marker group
pytest -m basic
pytest -m thread
pytest -m edge
pytest -m ttl
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
| Code quality | 25% | Correctness, edge cases, Python idioms |
| AI orchestration | 20% | How you used the AI (prompt history in your git log) |
| Architectural reasoning | 15% | Design decisions, trap awareness |
