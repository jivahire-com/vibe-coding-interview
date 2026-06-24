"""Public tests — visible in the candidate's branch.

All `basic` tests pass on the unmodified starter. Exactly one test each in
`rounding`, `currency`, and `allocate` FAILS on the starter on purpose — each
failure points at one of the three planted bugs you must fix.
"""

import pytest

from money import Money


# --- basic: these all pass on the starter ---


@pytest.mark.basic
def test_construct_and_equality():
    assert Money(435).cents == 435
    assert Money(435) == Money(435)
    assert Money(435) != Money(436)
    # Same cents but different currency is not equal.
    assert Money(100, "EUR") != Money(100, "USD")


@pytest.mark.basic
def test_add_same_currency():
    assert Money(125).add(Money(75)) == Money(200)


@pytest.mark.basic
def test_subtract_same_currency():
    assert Money(500).subtract(Money(150)) == Money(350)


@pytest.mark.basic
def test_multiply_repeats_amount():
    assert Money(150).multiply(3) == Money(450)


@pytest.mark.basic
def test_format_is_human_readable():
    assert Money(435).format() == "4.35 USD"
    assert Money(1999, "EUR").format() == "19.99 EUR"


# --- rounding: one hint test, FAILS on the starter ---


@pytest.mark.rounding
def test_from_string_lands_on_exact_cents():
    # The starter multiplies a binary float by 100 and truncates, so these
    # everyday prices land one cent low. Parse without a float to fix it.
    assert Money.from_string("4.35") == Money(435)
    assert Money.from_string("19.99") == Money(1999)


# --- currency: one hint test, FAILS on the starter ---


@pytest.mark.currency
def test_add_rejects_mismatched_currency():
    # You cannot add USD to EUR — this must raise, not silently combine cents.
    with pytest.raises(ValueError):
        Money(100, "USD").add(Money(100, "EUR"))


# --- allocate: one hint test, FAILS on the starter ---


@pytest.mark.allocate
def test_allocate_keeps_every_cent():
    parts = Money(500).allocate(3)
    # The split must sum back to the original — no cent lost or invented.
    assert sum(p.cents for p in parts) == 500
    # Leftover cents go to the leading pieces, one each.
    assert [p.cents for p in parts] == [167, 167, 166]
