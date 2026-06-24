"""Money — a small value type for handling currency amounts safely.

Money is stored as an integer number of minor units (cents for USD). Working in
whole cents avoids the classic floating-point rounding errors that make
0.1 + 0.2 != 0.3.

TODO(candidate): three rules below are not honoured by the starter yet. The
public `basic` tests pass; one test each in `rounding`, `currency`, and
`allocate` fails on purpose and points you at a planted bug.
"""

from __future__ import annotations

from typing import List


class Money:
    """An amount of money in a single currency, stored as integer cents."""

    __slots__ = ("cents", "currency")

    def __init__(self, cents: int, currency: str = "USD") -> None:
        self.cents = cents
        self.currency = currency

    @classmethod
    def from_string(cls, amount: str, currency: str = "USD") -> "Money":
        """Build Money from a decimal string such as "4.35" (-> 435 cents).

        TODO(candidate): this multiplies a binary float by 100 and truncates, so
        prices like "4.35" or "19.99" land one cent low (4.35 * 100 is actually
        434.999...). Parse the string without routing it through a float — the
        `decimal` module is the usual tool — and round to the nearest cent.
        """
        return cls(int(float(amount) * 100), currency)

    def add(self, other: "Money") -> "Money":
        """Return the sum of two amounts.

        TODO(candidate): adding two different currencies must raise ValueError —
        you can't add USD to EUR. Right now it silently adds the raw cents.
        """
        return Money(self.cents + other.cents, self.currency)

    def subtract(self, other: "Money") -> "Money":
        """Return the difference of two amounts.

        TODO(candidate): like add(), this must reject a currency mismatch.
        """
        return Money(self.cents - other.cents, self.currency)

    def multiply(self, factor: int) -> "Money":
        """Return this amount repeated `factor` times."""
        return Money(self.cents * factor, self.currency)

    def allocate(self, parts: int) -> List["Money"]:
        """Split this amount into `parts` pieces as evenly as possible.

        The pieces must sum back to the original amount — not a cent more or
        less. Hand the leftover cents to the leading pieces, one each, so the
        result is stable and fair.

        TODO(candidate): integer division alone drops the remainder. Splitting
        5 cents three ways returns [1, 1, 1] (= 3) and loses 2 cents. Distribute
        the remainder one cent at a time across the leading pieces.
        """
        if parts < 1:
            raise ValueError("parts must be at least 1")
        base = self.cents // parts
        return [Money(base, self.currency) for _ in range(parts)]

    def format(self) -> str:
        """Human-readable form, e.g. "4.35 USD"."""
        return f"{self.cents / 100:.2f} {self.currency}"

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Money):
            return NotImplemented
        return self.cents == other.cents and self.currency == other.currency

    def __repr__(self) -> str:
        return f"Money(cents={self.cents}, currency={self.currency!r})"
