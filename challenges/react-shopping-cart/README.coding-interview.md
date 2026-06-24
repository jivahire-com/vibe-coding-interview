# Shopping Cart Hook (React)

A small `useCart` hook — the part that holds and updates a shopping cart's
data — plus a `CartView` component that shows it on screen. The code you change
lives in
[src/useCart.js](src/useCart.js).

> **~45–75 minutes**  ·  no AI assistant  ·  graded on correctness **and** how you got there

---

## What to do

The cart fundamentals already work: adding a product merges into its existing
line, the subtotal multiplies price by quantity, and setting a quantity to zero
drops the line. Your job is the **discount-coupon layer** that was bolted on top
— and it has **three bugs**. You fix all three.

1. **Fractional cents.** A percentage coupon is worked out in plain floating
   point, so `SAVE10` on a `$9.99` cart takes off **99.9 cents** instead of a
   whole **100**. Every money value must stay a whole number of cents.
2. **The total can go negative.** Apply a coupon worth more than the cart and
   `cartTotal` drops **below zero**. A cart total must never be less than `$0`.
3. **Coupons that shouldn't count.** `applyCoupon` takes **anything** — it adds
   the **same coupon twice** (doubling its discount) and accepts **made-up
   codes** that aren't real coupons.

**Do it in this order:**

1. **Install and run the tests first, before changing any code** (see *How to run
   tests* below). A few tests fail on the starter — **on purpose.** Each failing
   test points at one of the bugs above.
2. **Read each failing test** and the **How discounts work** spec below,
   understand the behaviour expected, then fix the cause in
   [src/useCart.js](src/useCart.js).
3. **Run the tests again** until the whole visible suite is green.

Work the way you normally would — you're graded on understanding what you submit.

## How discounts work (the spec the tests check)

The hook ships with a fixed coupon catalogue (`COUPONS`):

| Code | Effect |
|---|---|
| `SAVE10` | 10% off the subtotal |
| `SAVE25` | 25% off the subtotal |
| `FIVEOFF` | $5.00 (500 cents) off |
| `TENOFF` | $10.00 (1000 cents) off |

- **Subtotal** is the sum of `price × quantity` across every line, in whole cents.
- **Each coupon** is computed off the subtotal: a **percent** coupon is
  `subtotal × value / 100` **rounded to the nearest cent, half rounding up**
  (`Math.round`); a **fixed** coupon is its flat cents value.
- **Round each coupon independently**, then add the results together — that is the
  `discount`. (Rounding the summed total instead can be off by a cent.)
- **`cartTotal` = `max(0, subtotal − discount)`** — never negative.
- A coupon code that isn't in `COUPONS` is **ignored**. The **same** code can't be
  applied **twice**.

## The rules your cart must follow

- **Money stays in whole cents.** `subtotal`, `discount`, and `cartTotal` are all
  integer cents (so `150` means `$1.50`). No fractional cents, no floating-point
  dollars leaking out.
- **Percentages round half-up, per coupon.** Round each coupon's discount to the
  nearest cent before summing, exactly as the spec above describes.
- **The total floors at zero.** `cartTotal` is never below `0`, even when coupons
  exceed the subtotal — but keep `subtotal` and `discount` themselves honest.
- **Only real, distinct coupons apply.** Reject codes that aren't in `COUPONS`,
  and refuse to add a coupon that's already applied.
- **Keep the method names.** `addItem`, `setQuantity`, `removeItem`,
  `applyCoupon`, `removeCoupon`, `clear`, `cartCount`, `subtotal`, `discount`,
  and `cartTotal` must keep their names — don't rename them.
- **Don't change state in place.** Always build and return new arrays and objects
  instead of editing the existing ones (this is what keeps the reducer "pure").

## You're done when

- [ ] All the visible tests pass — including the ones that failed at the start — and you didn't weaken or delete them.
- [ ] Percentage discounts land on whole cents; the total never goes negative; duplicate and unknown coupon codes are ignored.
- [ ] You can explain *why* each fix is correct — including *where* you round and *where* you floor — not just that the tests went green.
- [ ] Your changes are saved and committed (`git status` shows nothing left over) before you submit.

> When you submit, more tests run that you can't see while you work — extra edge
> cases for each of the three behaviours. The visible tests show you the idea;
> they are not the whole grade.

---

## Optional: go further (bonus)

Once the three bugs are fixed, here's a chance to show how you think about the
people who actually use this cart. This is **optional** — skipping it won't lower
your score, and doing it well can only help.

This cart is about to ship in a real store. Real stores have messy, real needs.
**Pick the one that interests you — or, better, describe a sharper one of your
own** — then build it and write tests that prove it works.

- **Best deal, not every deal.** When several coupons are applied, only keep the
  single one that helps the shopper most, instead of stacking them all.
- **Spend thresholds.** A coupon like `SAVE25` only unlocks once the subtotal is
  over some amount — and the UI should say how far away the shopper is.
- **Stock limits.** Each product has a `maxPerOrder`; the cart shouldn't let a
  quantity climb past it, and the UI should say why.
- **"You left something behind."** The cart — items and coupons — should survive a
  page refresh, so a half-filled cart isn't lost when the browser reloads.

What to build, and how far to take it, is your call — that judgement is what we're
looking at. Whatever you add, the rest of the rules still apply — **don't edit
state in place, round half-up, and keep money in whole cents.**

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

# All tests (vitest + jsdom)
npm test

# Filter by tag — test names end with @basic / @discount / @clamp / @coupons
npm run test:tag "@basic"
npm run test:tag "@discount"
npm run test:tag "@clamp"
npm run test:tag "@coupons"
```

On the **unmodified starter**, all `@basic` tests pass; one `@discount`, one
`@clamp`, and one `@coupons` test fail. Those failures are intentional. If
*every* test passes, you've changed the starter — get a fresh copy.

### Optional: see it running

There's a small visual playground that drives **your** `useCart` hook in a real
browser — a product list, quantity buttons, a coupon box, and a live summary.
It's **not graded and not a file you need to touch**; it's just a debugging aid.
The summary prints the raw cents next to each amount, so the planted bugs show
themselves — a discount that isn't a whole cent, a total that goes negative, or
the same coupon listed twice.

```bash
npm run dev
```

This opens `http://localhost:5173`. Your grade still comes only from `npm test`.

---

## Submitting & how you're graded

Submit your work however your interview tells you to, and make sure it's saved and
committed (`git status` should show nothing left) before time runs out.

| Dimension | Weight | What we look at |
|---|---|---|
| Getting it right | 40% | The hidden tests pass, including the edge cases, and the three planted bugs are fixed |
| How you worked | 15% | Running the tests as you go, not just at the end |
| Code quality | 20% | New objects instead of edited ones, clean and normal React |
| Your thinking | 25% | The choices you made — where to round, where to floor, where to validate — the bugs you spotted, and (if you did it) the optional extension |
