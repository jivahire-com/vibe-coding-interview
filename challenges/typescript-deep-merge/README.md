# Deep Merge Utility (TypeScript)

A small, generic `deepMerge<T>` function — the kind of helper that ends up at the
bottom of every config system. The code you change lives in
[src/deep_merge.ts](src/deep_merge.ts).

> **~35–60 minutes**  ·  AI assistance encouraged  ·  graded on correctness **and** how you got there

---

## What to do

The function already merges flat objects and nested plain objects correctly. But
it has **three bugs**. You fix all three.

1. **It changes its inputs.** `deepMerge(target, source)` writes back into
   `target`, and nested objects from `source` are shared instead of copied — it
   should return a **brand-new object** and leave both inputs untouched.
2. **It merges arrays.** Two arrays at the same key get merged **slot-by-slot**,
   so `["a","b","c"]` merged with `["x"]` becomes `["x","b","c"]` — an array
   should be treated as a **single value** and **replaced** as a whole (`["x"]`).
3. **It's a prototype-pollution hole.** A payload like
   `{"__proto__": {"isAdmin": true}}` (e.g. parsed from untrusted JSON) walks
   straight onto `Object.prototype`. Dangerous keys — `__proto__`,
   `constructor`, `prototype` — must be **skipped**.

**Do it in this order:**

1. **Install and run the tests first, before changing any code** (see *How to run
   tests* below). A few tests fail on the starter — **on purpose.** Each failing
   test points at one of the bugs above.
2. **Read each failing test**, understand what behaviour it expects, then fix the
   cause in [src/deep_merge.ts](src/deep_merge.ts).
3. **Run the tests again** until the whole visible suite is green.

Use the AI as a helper, not as autopilot — you're graded on understanding what you
submit, not on pasting answers.

## The rules your merge must follow

- **Never changes the inputs.** A fresh object comes back every time, and nested
  objects from the source are **copied**, not shared into the result.
- **Goes all the way down.** Nested plain objects merge key-by-key, at any depth.
- **Arrays are single values.** An array replaces whatever is at that key; it is
  never merged item-by-item.
- **Safe against `__proto__`.** The keys `__proto__`, `constructor`, and
  `prototype` can never reach `Object.prototype`.
- **Keep the function shape.** `deepMerge<T extends Plain>(target, source): T`
  and the `Plain` type must stay as they are — don't rename or re-shape them.

## You're done when

- [ ] All the visible tests pass — including the ones that failed at the start — and you didn't weaken or delete them.
- [ ] The result is a new object, arrays replace, and a `__proto__` payload can't pollute `Object.prototype`.
- [ ] You can explain *why* each fix is correct, not just that the tests went green.
- [ ] Your changes are saved and committed (`git status` shows nothing left over) before you submit.

> When you submit, more tests run that you can't see while you work — extra edge
> cases for each of the three behaviours. The visible tests show you the idea;
> they are not the whole grade.

---

## Optional: go further (bonus)

Once the three bugs are fixed, here's a chance to show how you think about the
people who actually call this helper. This is **optional** — skipping it won't
lower your score, and doing it well can only help.

This `deepMerge` is about to become the core of a real config loader. Real config
loaders have messy, real needs. **Pick the one that interests you — or, better,
describe a sharper one of your own** — then build it and write tests that prove it
works.

- **Custom array strategy.** Let the caller choose how arrays combine
  (`"replace"` vs `"concat"` vs de-duped union) via an options argument, defaulting
  to replace.
- **Typed merge result.** Improve the return type so merging `{a: number}` with
  `{b: string}` is known at compile time to be `{a: number; b: string}`, instead
  of collapsing to the target's type.
- **Merge many sources.** A `deepMergeAll(...sources)` that takes any number of
  objects and merges them one after another, left to right — with all the same
  rules above still holding.

**Do this one with the AI — that's the point of it.** We're watching how you drive
the AI from a fuzzy, real-world need all the way to a working, tested change:
framing the problem, weighing options, implementing, and asking it to write tests
that prove the new behaviour. Whatever you add, the rest of the rules still
apply — **don't change the inputs, and stay safe against `__proto__`.**

Then write a short **`NOTES.md`**:
- **Who** is affected, and what they needed.
- **What** you changed, and **why** that and not something else.
- **What you'd do next** with more time.

---

## How to run tests

**Fastest way — run the setup script** (installs Node if needed, then runs
`npm install`). From this challenge folder:

```bash
# macOS / Linux
bash setup.sh

# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File setup.ps1
```

The script prints the test command when it finishes. Prefer to do it by hand?

```bash
# First time only
npm install

# All tests (vitest)
npm test

# Filter by tag — test names end with @basic / @immutable / @arrays / @security
npm run test:tag "@basic"
npm run test:tag "@immutable"
npm run test:tag "@arrays"
npm run test:tag "@security"
```

On the **unmodified starter**, all `@basic` tests pass; one `@immutable`, one
`@arrays`, and one `@security` test fail. Those failures are intentional. If
*every* test passes, you've changed the starter — get a fresh copy.

---

## Using AI (you're encouraged to — we look at *how* you use it)

Open the **Vibe AI** panel in the sidebar. Your usage budget is shown at the top.

We pay attention to:
- **How you ask** — clear, specific questions, or do you paste the whole file and say "fix this"?
- **Whether you check the answers** — do you run the tests on the AI's code before you trust it?
- **Whether you understand it** — can you explain the code you end up submitting?

Using the AI's code is fine. Using it without testing it is not.

---

## Submitting & how you're graded

Click **Submit** in the Vibe AI sidebar, or run `Vibe: Submit` from the command palette
(`Ctrl+Shift+P`). If you forget, it submits automatically when time runs out — so save and
commit your work (`git status` should show nothing left) before then.

| Dimension | Weight | What we look at |
|---|---|---|
| How you used the AI | 36% | Asking good questions, testing what it gives you, saying no to bad suggestions |
| Getting it right | 20% | Which tag groups pass (hidden tests included) |
| Trap detection | 10% | Whether you found and fixed the three planted bugs |
| Code quality | 24% | Clean recursion, fresh copies instead of edited inputs, normal TypeScript |
| Architectural reasoning | 10% | The design choices you made (not ones inherited from the starter) |
