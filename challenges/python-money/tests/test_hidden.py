# Hidden tests — not visible in the candidate's branch.
# Grader copies this file into tests/ before running.
import pytest

from money import Money


# --- basic hidden ---


@pytest.mark.basic
def test_multiply_by_zero_and_repr():
    assert Money(150).multiply(0) == Money(0)
    assert "cents=150" in repr(Money(150))


@pytest.mark.basic
def test_format_handles_whole_amounts():
    assert Money(1000).format() == "10.00 USD"
    assert Money(5).format() == "0.05 USD"


# --- rounding hidden ---


@pytest.mark.rounding
def test_from_string_table_of_prices():
    cases = {
        "0.01": 1,
        "0.10": 10,
        "1.00": 100,
        "4.35": 435,
        "12.34": 1234,
        "19.99": 1999,
        "99.95": 9995,
        "100.00": 10000,
    }
    for text, cents in cases.items():
        assert Money.from_string(text) == Money(cents), text


@pytest.mark.rounding
def test_from_string_rounds_half_up_to_nearest_cent():
    # Sub-cent inputs round to the nearest cent, ties away from zero.
    # Truncating a float gets both of these wrong (267 and 0).
    assert Money.from_string("2.675") == Money(268)
    assert Money.from_string("0.005") == Money(1)


# --- currency hidden ---


@pytest.mark.currency
def test_subtract_rejects_mismatched_currency():
    with pytest.raises(ValueError):
        Money(500, "USD").subtract(Money(100, "GBP"))


@pytest.mark.currency
def test_same_currency_arithmetic_still_works():
    assert Money(100, "EUR").add(Money(50, "EUR")) == Money(150, "EUR")
    assert Money(100, "EUR").subtract(Money(40, "EUR")) == Money(60, "EUR")


# --- allocate hidden ---


@pytest.mark.allocate
def test_allocate_even_split_has_no_remainder():
    parts = Money(900).allocate(3)
    assert [p.cents for p in parts] == [300, 300, 300]


@pytest.mark.allocate
def test_allocate_remainder_goes_to_leading_pieces():
    parts = Money(1000).allocate(3)
    assert [p.cents for p in parts] == [334, 333, 333]
    assert sum(p.cents for p in parts) == 1000


@pytest.mark.allocate
def test_allocate_more_parts_than_cents():
    parts = Money(2).allocate(5)
    assert [p.cents for p in parts] == [1, 1, 0, 0, 0]
    assert sum(p.cents for p in parts) == 2


@pytest.mark.allocate
def test_allocate_keeps_currency_and_rejects_zero_parts():
    parts = Money(300, "EUR").allocate(2)
    assert all(p.currency == "EUR" for p in parts)
    with pytest.raises(ValueError):
        Money(100).allocate(0)
