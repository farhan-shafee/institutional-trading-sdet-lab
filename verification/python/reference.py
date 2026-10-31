"""Independent financial oracle, authored from the Phase 1 convention contract.

No application modules are imported. Fractional discounting uses Decimal ln/exp;
inverse pricing uses safeguarded Newton iteration; risk derivatives use a
convergence-checked five-point finite difference, not cash-flow derivatives.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal, ROUND_HALF_EVEN, localcontext
from fractions import Fraction
import calendar
import re


D = Decimal
PRECISION = 72
MIN_YIELD = D("-0.10")
MAX_YIELD = D("1.00")
BP = D("0.0001")
DATED_DATE = date(2025, 1, 15)
MATURITY_DATE = date(2031, 1, 15)
COUPON = D("2")
INSTRUMENTS = {
    "SYN-UST-2031": "ACT_ACT_ICMA",
    "SYN-CORP-2031": "THIRTY_360_US",
}
SCALES = {
    "yield": 12,
    "clean_price": 10,
    "dirty_price": 10,
    "accrued_interest": 10,
    "macaulay_duration": 10,
    "modified_duration": 10,
    "convexity": 10,
    "dv01_usd": 8,
    "consideration_usd": 2,
}


def strict_date(value: str) -> date:
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        raise ValueError("date must be YYYY-MM-DD")
    return date.fromisoformat(value)


def _is_february_end(value: date) -> bool:
    return value.month == 2 and value.day == calendar.monthrange(value.year, 2)[1]


def us_30_360_days(start: date, end: date) -> int:
    """US 30/360: February-EOM pair and conditional 31st-day adjustments."""
    first, last = start.day, end.day
    if _is_february_end(start) and _is_february_end(end):
        last = 30
    if _is_february_end(start) or first == 31:
        first = 30
    if last == 31 and first >= 30:
        last = 30
    return 360 * (end.year - start.year) + 30 * (end.month - start.month) + last - first


def coupon_dates() -> tuple[date, ...]:
    # Construct dates by year, independently of the application's schedule code.
    return tuple(
        date(year, month, 15)
        for year in range(2025, 2032)
        for month in (1, 7)
        if DATED_DATE <= date(year, month, 15) <= MATURITY_DATE
    )


@dataclass(frozen=True)
class Valuation:
    instrument_id: str
    settlement: date
    previous: date
    following: date
    remaining: tuple[date, ...]
    accrual_fraction: Decimal
    accrual_days: int
    accrual_period_days: int

    @property
    def accrued_interest(self) -> Decimal:
        with localcontext() as ctx:
            ctx.prec = PRECISION
            return COUPON * self.accrual_fraction

    def dirty(self, annual_yield: Decimal) -> Decimal:
        with localcontext() as ctx:
            ctx.prec = PRECISION
            base = 1 + annual_yield / 2
            if base <= 0:
                raise ValueError("nonpositive discount base")
            log_base = base.ln()
            # Each payment's time is recomputed directly from its ordinal.
            values = []
            for ordinal, payment in enumerate(self.remaining, start=1):
                periods = D(ordinal) - self.accrual_fraction
                cash = COUPON + (100 if payment == MATURITY_DATE else 0)
                values.append(cash * (-periods * log_base).exp())
            return sum(values, D(0))

    def clean(self, annual_yield: Decimal) -> Decimal:
        with localcontext() as ctx:
            ctx.prec = PRECISION
            return self.dirty(annual_yield) - self.accrued_interest

    def derivatives(self, annual_yield: Decimal) -> tuple[Decimal, Decimal]:
        """Richardson-extrapolated five-point finite differences with a check."""
        with localcontext() as ctx:
            ctx.prec = PRECISION
            center = self.dirty(annual_yield)

            def five_point(h: Decimal) -> tuple[Decimal, Decimal]:
                minus2 = self.dirty(annual_yield - 2 * h)
                minus1 = self.dirty(annual_yield - h)
                plus1 = self.dirty(annual_yield + h)
                plus2 = self.dirty(annual_yield + 2 * h)
                first = (minus2 - 8 * minus1 + 8 * plus1 - plus2) / (12 * h)
                second = (-minus2 + 16 * minus1 - 30 * center + 16 * plus1 - plus2) / (12 * h * h)
                return first, second

            coarse = five_point(D("0.0001"))
            middle = five_point(D("0.00005"))
            fine = five_point(D("0.000025"))
            first_estimate = tuple((16 * m - c) / 15 for c, m in zip(coarse, middle))
            final_estimate = tuple((16 * f - m) / 15 for m, f in zip(middle, fine))
            for earlier, later in zip(first_estimate, final_estimate):
                if abs(earlier - later) > D("1e-18") * max(D(1), abs(later)):
                    raise ArithmeticError("finite-difference derivative did not converge")
            return final_estimate

    def yield_for_clean(self, market_clean: Decimal) -> Decimal:
        """Solve exact market input with Newton steps and secant safeguards."""
        with localcontext() as ctx:
            ctx.prec = PRECISION
            if not market_clean.is_finite() or not 0 < market_clean <= 10000:
                raise ValueError("unsupported market price")
            target = market_clean + self.accrued_interest
            low, high = MIN_YIELD, MAX_YIELD
            low_error = self.dirty(low) - target
            high_error = self.dirty(high) - target
            # The API's ten-place wire quote may lie at most half an output
            # quantum beyond an endpoint. Only this endpoint-rounding case is
            # clamped; wider out-of-bracket market prices remain invalid.
            quote_half_quantum = D("0.00000000005")
            if low_error < 0:
                if -low_error <= quote_half_quantum:
                    return low
                raise ValueError("price is outside the supported yield interval")
            if high_error > 0:
                if high_error <= quote_half_quantum:
                    return high
                raise ValueError("price is outside the supported yield interval")
            if low_error == 0:
                return low
            if high_error == 0:
                return high
            guess = D("0.04")
            for _ in range(100):
                error = self.dirty(guess) - target
                if abs(error) < D("1e-55"):
                    return guess
                if error > 0:
                    low, low_error = guess, error
                else:
                    high, high_error = guess, error
                # A two-point local slope is numerically independent of the
                # derivative computation used for the reported risk measures.
                step = D("1e-12")
                slope = (self.dirty(guess + step) - self.dirty(guess - step)) / (2 * step)
                proposed = guess - error / slope
                if not low < proposed < high:
                    proposed = low - low_error * (high - low) / (high_error - low_error)
                # Secant can stagnate near one end of a wide interval. An
                # interior weighted step guarantees a fresh usable point.
                if proposed == guess or not low < proposed < high:
                    proposed = (2 * low + high) / 3
                guess = proposed
            raise ArithmeticError("Newton/secant inverse did not converge")

    @staticmethod
    def _rational_cents(amount: Fraction) -> Decimal:
        """Round an exact positive rational cash amount to cents, ties to even."""
        scaled = amount * 100
        whole, remainder = divmod(scaled.numerator, scaled.denominator)
        comparison = 2 * remainder - scaled.denominator
        if comparison > 0 or (comparison == 0 and whole % 2):
            whole += 1
        return D(whole).scaleb(-2)

    def consideration(self, annual_yield: Decimal, par: Decimal,
                      market_clean: Decimal | None = None) -> Decimal:
        """Decide the final cent exactly, including fractional-power ties.

        A finite Decimal approximation cannot decide a true half-cent tie.
        For a quote the whole cash amount is rational. For yield pricing,
        factor PV into a rational payment sum times base**(elapsed/period).
        A positive rational comparison raised to the period denominator
        decides which side of a half-cent boundary the exact cash lies on.
        Decimal is used only to locate the neighboring cent candidates.
        """
        accrual = Fraction(self.accrual_days, self.accrual_period_days)
        notional_scale = Fraction(par) / 100
        if market_clean is not None:
            amount = (Fraction(market_clean) + 2 * accrual) * notional_scale
            return self._rational_cents(amount)

        base = 1 + Fraction(annual_yield) / 2
        rational_sum = sum(
            (Fraction(2 + (100 if payment == MATURITY_DATE else 0)) / base ** ordinal
             for ordinal, payment in enumerate(self.remaining, start=1)),
            Fraction(0),
        )
        coefficient = rational_sum * notional_scale
        if accrual == 0:
            return self._rational_cents(coefficient)
        with localcontext() as ctx:
            ctx.prec = PRECISION
            approximate_cash = self.dirty(annual_yield) * par / 100
            lower_cent = int(approximate_cash * 100)
        half_cent = Fraction(2 * lower_cent + 1, 200)
        exponent_numerator = accrual.numerator
        exponent_denominator = accrual.denominator
        left = coefficient ** exponent_denominator * base ** exponent_numerator
        right = half_cent ** exponent_denominator
        comparison = (left > right) - (left < right)
        cent = lower_cent + (comparison > 0 or (comparison == 0 and lower_cent % 2))
        return D(cent).scaleb(-2)

    def analytics(self, annual_yield: Decimal, par: Decimal,
                  market_clean: Decimal | None = None) -> dict[str, Decimal]:
        with localcontext() as ctx:
            ctx.prec = PRECISION
            if not annual_yield.is_finite() or not MIN_YIELD <= annual_yield <= MAX_YIELD:
                raise ValueError("unsupported yield")
            if not par.is_finite() or not 1 <= par <= 1000000000 or par != par.quantize(D("0.01")):
                raise ValueError("unsupported par")
            dirty = self.dirty(annual_yield)
            quoted_dirty = market_clean + self.accrued_interest if market_clean is not None else dirty
            first, second = self.derivatives(annual_yield)
            modified = -first / dirty
            return {
                "yield": annual_yield,
                "clean_price": market_clean if market_clean is not None else dirty - self.accrued_interest,
                "dirty_price": quoted_dirty,
                "accrued_interest": self.accrued_interest,
                "macaulay_duration": modified * (1 + annual_yield / 2),
                "modified_duration": modified,
                "convexity": second / dirty,
                "dv01_usd": (self.dirty(annual_yield - BP) - self.dirty(annual_yield + BP)) * par / 200,
                "consideration_usd": self.consideration(annual_yield, par, market_clean),
            }


def valuation(instrument_id: str, settlement: str) -> Valuation:
    if instrument_id not in INSTRUMENTS:
        raise ValueError("unknown synthetic instrument")
    when = strict_date(settlement)
    if not DATED_DATE <= when < MATURITY_DATE:
        raise ValueError("settlement outside instrument lifetime")
    schedule = coupon_dates()
    previous = max(payment for payment in schedule if payment <= when)
    remaining = tuple(payment for payment in schedule if payment > when)
    following = remaining[0]
    with localcontext() as ctx:
        ctx.prec = PRECISION
        if INSTRUMENTS[instrument_id] == "ACT_ACT_ICMA":
            elapsed, period = (when - previous).days, (following - previous).days
        else:
            elapsed, period = us_30_360_days(previous, when), 180
        fraction = D(elapsed) / D(period)
    return Valuation(instrument_id, when, previous, following, remaining, fraction, elapsed, period)


def fixed(value: Decimal, scale: int) -> str:
    with localcontext() as ctx:
        ctx.prec = PRECISION
        return format(value.quantize(D(1).scaleb(-scale), rounding=ROUND_HALF_EVEN), "f")


def formatted(values: dict[str, Decimal]) -> dict[str, str]:
    return {field: fixed(value, SCALES[field]) for field, value in values.items()}
