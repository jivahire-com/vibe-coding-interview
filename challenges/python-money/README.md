# Money Value Type (Python 3.11+)

A small `Money` type that stores amounts as whole **cents**, to avoid the
rounding errors you get from using decimal (floating-point) numbers for money.
The code you change lives in [src/money.py](src/money.py).

> **~40–60 minutes**  ·  AI assistance encouraged  ·  graded on correctness **and** how you got there

---

## What to do

The type already constructs, compares, adds, multiplies, and formats money. But
it has **three bugs**. You fix all three.

1. **A cent goes missing when reading a price.** `Money.from_string("4.35")`
   should be `435` cents, but the starter multiplies the decimal by 100 and chops
   off the rest, so it returns **434**. Prices like `"19.99"` are wrong too.
2. **Currencies get mixed.** Adding (or subtracting) **USD and EUR** just
   combines the cents anyway, instead of **raising an error**.
3. **Cents vanish when splitting.** `Money(500).allocate(3)` returns three pieces
   that add up to **498**, not 500 — the leftover cents are dropped.

**Do it in this order:**

1. **Install and run the tests first, before changing any code** (see *How to run
   tests* below). Most tests pass; **one `rounding`, one `currency`, and one
   `allocate` test fail on purpose** — each points at one of the bugs above.
2. **Read each failing test**, understand the behaviour it expects, then fix the
   cause in [src/money.py](src/money.py).
3. **Run the tests again** until the whole visible suite is green.

Use the AI as a helper, not as autopilot — you're graded on understanding what
you submit, not on pasting answers.

## The rules your `Money` must follow

- **Money is whole cents.** `150` means `$1.50`. Never store an amount as a
  decimal number — that's the whole point of this type.
- **Reading a price is exact.** `from_string` turns a price written as text into
  the nearest cent. When a value lands exactly halfway, round **up (away from
  zero)**, and don't turn it into a decimal number along the way — the `decimal`
  module is the usual tool. `"4.35"` → `435`, `"2.675"` → `268`.
- **Currencies can't be mixed.** `add` and `subtract` must raise a `ValueError`
  when the two amounts are in different currencies. Same-currency math is
  unchanged.
- **`allocate(parts)` loses nothing.** The pieces must add back up to the original
  amount exactly. Give the leftover cents to the **first** pieces, one each, so
  `Money(500).allocate(3)` → `[167, 167, 166]`.
- **Keep the method names.** `from_string`, `add`, `subtract`,
  `multiply`, `allocate`, and `format` must keep their names — don't rename them.

## You're done when

- [ ] All the visible tests pass — including the ones that failed at the start — and you didn't weaken or delete them.
- [ ] Parsing lands on the exact cent; cross-currency math raises; `allocate` preserves every cent.
- [ ] You can explain *why* each fix is correct, not just that the tests went green.
- [ ] Your changes are saved and committed (`git status` shows nothing left over) before you submit.

> When you submit, more tests run that you can't see while you work — a table of
> tricky prices, sub-cent rounding, currency guards on both operations, and
> uneven splits. The visible tests show you the idea; they are not the whole grade.

---

## Optional: go further (bonus)

Once the three bugs are fixed, here's a chance to show how you think about the
people who actually use this type. This is **optional** — skipping it won't lower
your score, and doing it well can only help.

This `Money` type is about to ship inside a real billing system. Real billing has
messy, real needs. **Pick the one that interests you — or, better, describe a
sharper one of your own** — then build it and write tests that prove it works.

- **Splitting a bill fairly.** A `$10.00` charge split 3 ways shouldn't always
  load the same first person with the extra cent every time — can the leftover be
  distributed by a rule the caller chooses?
- **Reading messy input.** Customers paste `"$1,234.50"`, `"1234.5"`, and
  `"  19.99 "`. Decide what `from_string` should accept and what it should reject.
- **Negative and zero money.** Refunds are negative; a `$0.00` line is real. Make
  sure formatting, allocation, and comparison all behave sensibly.

**Do this one with the AI — that's the point of it.** We're watching how you drive
the AI from a fuzzy, real-world need all the way to a working, tested change:
framing the problem, weighing options, implementing, and asking it to write tests
that prove the new behaviour. Whatever you add, the rest of the rules still
apply — **keep money in whole cents and reading prices exact.**

Then write a short **`NOTES.md`**:
- **Who** is affected, and what they needed.
- **What** you changed, and **why** that and not something else.
- **What you'd do next** with more time.

---

## How to run tests

**Fastest way — run the setup script** (installs Python if needed, creates the
virtualenv, installs the test tools). From this challenge folder:

```bash
# macOS / Linux
bash setup.sh

# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File setup.ps1
```

The script prints the test command when it finishes. Prefer to do it by hand?

```bash
# First time only — install into a venv
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -e ".[dev]"

# All tests
pytest

# Filter by marker group
pytest -m basic
pytest -m rounding
pytest -m currency
pytest -m allocate
```

On the **unmodified starter**, all `basic` tests pass; exactly one `rounding`,
one `currency`, and one `allocate` test fail. Those failures are intentional. If
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
| How you used the AI | 20% | Asking good questions, testing what it gives you, saying no to bad suggestions |
| Getting it right | 25% | Which marker groups pass (hidden tests included) |
| Trap detection | 15% | Whether you found and fixed the three planted bugs |
| Code quality | 25% | Exact decimal handling, clear currency checks, clean and normal Python |
| Architectural reasoning | 15% | The design choices you made (not ones inherited from the starter) |
