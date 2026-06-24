# Money Value Type (Python 3.11+)

A small `Money` type that stores amounts as whole **cents**, so the math doesn't
pick up the tiny rounding errors that decimal (floating-point) numbers do. The
code you change lives in
[src/money.py](src/money.py).

> **~40–60 minutes**  ·  no AI assistant  ·  graded on correctness **and** how you got there

---

## What to do

The starter already constructs, compares, adds, multiplies, and formats money.
The visible tests show how it's meant to behave — but it has **three problems**:

1. **A cent goes missing when reading a price.** Turning the text `"4.35"` into
   money gives **434** cents instead of 435 (and `"19.99"` is wrong too).
2. **Two different currencies can be added together** as if they were the same —
   that should not be allowed.
3. **Splitting an amount loses money.** Splitting 500 cents three ways gives back
   pieces that add up to **498**, not 500.

Your task is to fix all three.

**Do it in this order:**

1. **Set up the project and run the tests first, before changing any code** (see
   *Build & run* below). Most tests pass, but **one `rounding`, one `currency`,
   and one `allocate` test fail on purpose** — each one shows you exactly where a
   bug is hidden.
2. **Read each failing test**, understand why it fails, then fix that cause in
   [src/money.py](src/money.py).
3. **Run the tests again** until everything visible is green.

Work the way you normally would — you're graded on understanding what you submit.

## The rules your `Money` must follow

Every one of these has to be true. Some are not true in the starter yet — that's
what you fix.

- **Money is whole cents.** `150` means `$1.50`. Never store an amount as a
  decimal number — that's the whole reason this type exists.
- **Reading a price is exact.** Turning text like `"4.35"` into money must give
  the **exact** nearest cent — `435`, never 434. When a value lands exactly
  halfway, round **up (away from zero)** (so `"2.675"` → `268`).
- **You can't mix currencies.** Adding or subtracting two amounts in different
  currencies must **raise an error**. Same-currency math keeps working as before.
- **Splitting keeps every cent.** Splitting an amount into pieces must add back up
  to exactly the original. Give the leftover cents to the **first** pieces, one
  each — so 500 split three ways is `167, 167, 166`.
- **Don't rename the methods.** `from_string`, `add`, `subtract`, `multiply`,
  `allocate`, and `format` must keep their names.

## You're done when

- [ ] All the visible tests pass — including the three that failed at the start — and you didn't just delete or weaken them.
- [ ] Reading a price lands on the exact cent; mixing currencies raises an error; splitting never loses a cent.
- [ ] You can explain *why* each fix is correct — not just that the tests went green.
- [ ] Your changes are saved and committed (`git status` shows nothing left over) before you submit.

> When you submit, more tests run that you can't see while you work — a whole
> table of tricky prices, halfway-rounding cases, currency checks on both add and
> subtract, and uneven splits. The visible tests only show you the general idea;
> they are not the whole grade.

---

## Optional: go further (bonus)

Once the core task works, here's a chance to show how you think about the people
who actually use this type. This is **optional** — skipping it won't lower your
score, and doing it well can only help.

This `Money` type is about to ship inside a real billing system, and real billing
has messy needs. **Pick the one that interests you — or, better, describe a
sharper one of your own** — then build it and write tests that prove it works.

- **Splitting a bill fairly.** A `$10.00` charge split 3 ways shouldn't always
  hand the extra cent to the same first person — could the leftover follow a rule
  the caller picks?
- **Reading messy input.** People type `"$1,234.50"`, `"1234.5"`, and `"  19.99 "`.
  Decide what reading a price should accept, and what it should reject outright.
- **Negative and zero money.** Refunds are negative; a `$0.00` line is real. Make
  sure formatting, splitting, and comparison all behave sensibly.

What to build, and how far to take it, is your call — that judgement is what we're
looking at.

Then write a short **`NOTES.md`**:
- **Who** is affected, and what they needed.
- **What** you changed, and **why** that and not something else.
- **What you'd do next** with more time.

---

## Build & run

**Fastest way — run the setup script** (installs Python if needed, creates the
virtualenv, installs the test tools). From this challenge folder:

```bash
# macOS / Linux
bash setup.sh

# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File setup.ps1
```

Prefer to do it by hand? **You need:** Python 3.11+, pip, and Git. Nothing else
to install — `pytest` is pulled in by the editable install below.

```bash
# First time only — install into a venv
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -e ".[dev]"

# Run all tests
pytest

# Run a specific marker group
pytest -m basic
pytest -m rounding
pytest -m currency
pytest -m allocate
```

On the **unmodified starter**, all `basic` tests pass, but the `rounding`,
`currency`, and `allocate` hint tests fail — those failures are intentional
(planted bugs). If *every* test passes, you've changed the starter — get a fresh
copy.

**Troubleshooting**
- **`python3: command not found`** — macOS `brew install python@3.11`; Ubuntu `sudo apt install python3.11 python3.11-venv`.
- **`No module named pytest`** — you skipped `pip install -e ".[dev]"`; activate the venv first, then re-run.
- **`ImportError: money`** — the package installs in editable mode from `src/`; if you renamed the file, update `pyproject.toml` too.

---

## Submitting & how you're graded

Submit your work however your interview tells you to, and make sure it's saved and
committed (`git status` should show nothing left) before time runs out.

| Dimension | Weight | What we look at |
|---|---|---|
| Getting it right | 40% | The hidden tests pass — tricky prices, halfway rounding, currency guards on both add and subtract, uneven splits — and the three planted bugs are fixed |
| How you worked | 15% | Running the tests as you go, not just at the end |
| Code quality | 20% | Exact decimal handling, clear currency checks, clean and normal Python |
| Your thinking | 25% | The choices you made, the bugs you spotted, and (if you did it) the optional extension |
