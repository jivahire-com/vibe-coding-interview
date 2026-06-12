# Thread-Safe Cache (C++17)

A templated, fixed-capacity cache with least-recently-used (LRU) eviction.
The public API lives in `include/lru_cache.hpp`.

> **~60 minutes**  ·  AI assistance encouraged  ·  graded on correctness **and** how you got there

---

## What to do

The starter is a cache that works on a single thread. It **builds**, and the
visible `[basic]` tests show how it's meant to behave — but it has **two problems**:

1. It **doesn't do everything the rules below say** — at least one rule is broken
   (one `[basic]` test already fails on the starter, before you touch anything).
2. It is **not safe to use from more than one thread** — if several threads call it
   at once, the data gets corrupted.

Your task is to fix both.

**Do it in this order:**

1. **Set up and build the project** — you need CMake 3.14+ and a C++17 compiler
   (see *Build & run* below). Catch2 is downloaded for you; nothing else to install.
2. **Run the tests first, before changing any code.** One `[basic]` test fails on
   the starter — **this is on purpose.** It shows you where a bug is hidden. Run it,
   understand why it fails, and fix that bug first.
3. **Then make it safe to use from many threads at once**, and make sure it follows
   all the rules below. After you submit, extra tests check this under heavy
   multi-threaded load.

Use the AI as a helper, not as autopilot — you're graded on understanding what you
submit, not on pasting answers.

## The rules your cache must follow

Every one of these has to be true. Some are not true in the starter yet — that's what you fix.

- **Never hold more than `capacity` items.** That limit is a hard maximum.
- **A `capacity` of 0 is allowed** — such a cache simply never stores anything.
- **`get(key)` is fast (O(1))** — returns the value if it's there (and marks it as just-used), or nothing if it isn't.
- **`put(key, value)` is fast (O(1))** — adds or updates an item; when full, it removes the item that hasn't been used for the longest time.
- **Updating a key that already exists** changes its value but does **not** add a new item.
- **Safe to call from many threads at once** — no corruption, no half-written data, no crashes.

> **One thing to think about.** This cache is used in a **read-heavy** way: `get`
> is called far more often than `put`. Choose a locking approach that fits that —
> but make sure it's actually correct for what each operation really does to the data.

## You're done when

- [ ] All the visible `[basic]` tests pass — including the one that failed at the start — and you didn't just delete or weaken them.
- [ ] Every rule above is true, including the ones the starter breaks today.
- [ ] It's safe under many threads calling `get`/`put` at once. (The hidden tests check this with a tool called ThreadSanitizer.)
- [ ] You can explain *why* your locking is correct — not just that the tests went green.
- [ ] Your changes are saved and committed (`git status` shows nothing left over) before you submit.

> When you submit, more tests run that you can't see while you work — heavy
> multi-threaded tests and extra edge cases. The visible tests only show you the
> general idea; they are not the whole grade.

---

## Optional: go further (bonus)

Once the core task works, here's a chance to show how you think about the people
who actually use this cache. This is **optional** — skipping it won't lower your
score, and doing it well can only help.

This cache is about to ship inside a real product — and real products have users
and operators whose needs the code has to serve. Below are a few situations teams
genuinely run into. **Pick the one that interests you — or, better, describe a
sharper one of your own** — then decide what the cache should do about it.

- **2 a.m. page.** A service is slow and the on-call engineer suspects this cache,
  but has no way to tell whether it's actually helping or just getting in the way.
- **Stale answers.** The data behind the cache changes over time, and some users are
  quietly being served old values without anyone noticing.
- **Silent drop-outs.** When the cache fills up, entries fall out of it — and another
  part of the system needed to know that happened.

**Do this one with the AI — that's the point of it.** We're not testing whether you
can code a feature unaided; we're watching how you drive the AI from a fuzzy, real
world need all the way to a working, tested change: framing the problem, weighing
options, implementing, and asking it to write tests that prove the new behaviour.
What to build, and how far to take it, is your call — that judgement is what we're
looking at. Whatever you add, the rest of the challenge still applies: **any new
state has to be thread-safe too** — a counter two threads can corrupt is its own bug.

Then write a short **`NOTES.md`**:
- **Who** is affected, and what they needed.
- **What** you changed, and **why** that and not something else.
- **What you'd do next** with more time.

---

## Build & run

**You need:** CMake 3.14+, a C++17 compiler (GCC 11+, Clang 14+, or MSVC 2019+),
and Git. Nothing else to install — Catch2 is fetched automatically on the first build.

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

On the **unmodified starter**, most tests pass but the "LRU eviction order"
`[basic]` test fails — that failure is intentional (a planted bug). If *every*
test passes, you're on a modified tree; re-clone.

**Troubleshooting**
- **`cmake: command not found`** — macOS `brew install cmake`; Ubuntu `sudo apt install cmake`.
- **`c++` / `clang++` not found** — macOS `xcode-select --install`; Ubuntu `sudo apt install build-essential clang`.
- **FetchContent fails** — the first build needs internet to download Catch2; after that `build/_deps/` is cached and offline builds work.
- **ThreadSanitizer not available** — TSan needs Clang/GCC on Linux/macOS (MSVC doesn't support it). The visible tests don't use TSan; the grader always runs it on Linux.

---

## Using AI (you're encouraged to — we look at *how* you use it)

Open the **Vibe AI** panel in the sidebar. Your usage budget is shown at the top.

We pay attention to:
- **How you ask** — clear, specific questions, or do you paste the whole file and say "fix this"?
- **Whether you check the answers** — do you test the AI's code before you trust it?
- **Whether you understand it** — can you explain the code you end up submitting?

Using the AI's code is fine. Using it without testing it is not.

---

## Submitting & how you're graded

Click **Submit** in the Vibe AI sidebar, or run `Vibe: Submit` from the command palette
(`Ctrl+Shift+P`). If you forget, it submits automatically when time runs out — so save and
commit your work (`git status` should show nothing left) before then.

**We don't show you the exact scoring, but here's what counts and how much:**

- **How you used the AI — 38%.** Asking good questions, testing what it gives you, and saying no to bad suggestions.
- **Getting it right — 32%.** The hidden tests pass, including the edge cases and the multi-threaded ones.
- **Code quality — 15%.** Clean, readable, sensible C++.
- **Your thinking — 15%.** The choices you made, the bugs you spotted, and why your locking is correct.
