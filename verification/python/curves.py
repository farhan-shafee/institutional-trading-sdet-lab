"""Independent Phase4B oracle from the approved written financial contract.
Python Decimal125 log-DF interpolation and safeguarded analytic-Newton inversion;
no application imports, generated expectations, market feeds, or posted cash.
"""
import calendar
from datetime import date
from decimal import Decimal, localcontext, ROUND_HALF_EVEN
from fractions import Fraction
import json
import re
import sys

OFFSETS = (365, 730, 1825, 3650)
RATES = {
    "BASE_UP_V1": ("0.02", "0.025", "0.03", "0.035"),
    "FLAT_V1": ("0.03",) * 4,
    "NEGATIVE_V1": ("-0.01",) * 4,
}
IDS = ("SYN-UST-2031", "SYN-CORP-2031", "SYN-ZERO-2031")
DATED, MATURITY = date(2025, 1, 15), date(2031, 1, 15)


def dec(fraction):
    return Decimal(fraction.numerator) / Decimal(fraction.denominator)


def rounded_fraction(value, places=2):
    scale = 10 ** places
    units, remainder = divmod(abs(value.numerator) * scale, value.denominator)
    if 2 * remainder > value.denominator or (2 * remainder == value.denominator and units % 2):
        units += 1
    sign = "-" if value < 0 and units else ""
    digits = str(units).zfill(places + 1)
    return sign + digits[:-places] + "." + digits[-places:]


def us_30_360(start, end):
    a, b = start.day, end.day
    first_feb = start.month == 2 and a == calendar.monthrange(start.year, 2)[1]
    last_feb = end.month == 2 and b == calendar.monthrange(end.year, 2)[1]
    if first_feb and last_feb:
        b = 30
    if first_feb or a == 31:
        a = 30
    if b == 31 and a >= 30:
        b = 30
    return 360 * (end.year - start.year) + 30 * (end.month - start.month) + b - a


def cash_flows(instrument, asof):
    if instrument == "SYN-ZERO-2031":
        return Fraction(0), [(MATURITY, Fraction(100))]
    schedule = [date(y, m, 15) for y in range(2025, 2032) for m in (1, 7)
                if DATED < date(y, m, 15) <= MATURITY]
    previous = max([DATED] + [d for d in schedule if d <= asof])
    future = [d for d in schedule if d > asof]
    if instrument == "SYN-UST-2031":
        accrued = 2 * Fraction((asof - previous).days, (future[0] - previous).days)
    else:
        accrued = 2 * Fraction(us_30_360(previous, asof), 180)
    return accrued, [(d, Fraction(102 if d == MATURITY else 2)) for d in future]


class Curve:
    def __init__(self, fixture):
        rates = RATES[fixture]
        self.points = [(0, Decimal(0))] + [
            (n, -Decimal(r) * Decimal(n) / 365) for n, r in zip(OFFSETS, rates)]
        self.exact = [(0, Fraction(0))] + [
            (n, -Fraction(r) * n / 365) for n, r in zip(OFFSETS, rates)]

    def exponent_exact(self, days, spread):
        for (a, fa), (b, fb) in zip(self.exact, self.exact[1:]):
            if a <= days <= b:
                return fa + (fb - fa) * Fraction(days - a, b - a) - Fraction(spread) * days / 365
        raise ValueError("Extrapolation")

    def df(self, days, spread):
        # Exact cancellation is an algebraic identity, not a rounded Decimal coincidence.
        if self.exponent_exact(days, spread) == 0:
            return Decimal(1)
        for (a, la), (b, lb) in zip(self.points, self.points[1:]):
            if a <= days <= b:
                log_df = la + (lb - la) * Decimal(days - a) / Decimal(b - a)
                return (log_df - spread * Decimal(days) / 365).exp()
        raise ValueError("Extrapolation")


def pv_and_slope(curve, dated_flows, asof, spread):
    value, slope = Decimal(0), Decimal(0)
    for payment, amount in dated_flows:
        days = (payment - asof).days
        discounted = dec(amount) * curve.df(days, spread)
        value += discounted
        slope -= discounted * Decimal(days) / 365
    return value, slope


def inverse(curve, flows, asof, target_fraction):
    target = dec(target_fraction)
    lo, hi = Decimal("-0.10"), Decimal("1")
    upper, _ = pv_and_slope(curve, flows, asof, lo)
    lower, _ = pv_and_slope(curve, flows, asof, hi)
    quantum = Decimal("0.00000000005")
    if target > upper + quantum or target < lower - quantum:
        raise ValueError("Unsupported spread target")
    if target >= upper:
        return lo
    if target <= lower:
        return hi
    spread = Decimal(0)
    for _ in range(200):
        value, slope = pv_and_slope(curve, flows, asof, spread)
        residual = value - target
        if abs(residual) < Decimal("1e-100"):
            return spread
        if residual > 0:
            lo = spread
        else:
            hi = spread
        candidate = spread - residual / slope
        spread = candidate if lo < candidate < hi else (lo + hi) / 2
    raise ValueError("Independent safeguarded Newton did not converge")


def query(q):
    required = {"instrument_id", "fixture_id", "as_of_date", "par_amount"}
    if set(q) - required - {"z_spread", "clean_price"} or not required <= set(q):
        raise ValueError("Unexpected/missing oracle input")
    if ("z_spread" in q) == ("clean_price" in q):
        raise ValueError("Exclusive quote mode")
    if q["instrument_id"] not in IDS or q["fixture_id"] not in RATES:
        raise ValueError("Unknown instrument/fixture")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", q["as_of_date"]):
        raise ValueError("Invalid Gregorian date")
    asof = date.fromisoformat(q["as_of_date"])
    if not DATED <= asof < MATURITY:
        raise ValueError("Unsupported as-of")
    if not re.fullmatch(r"\d{1,10}(?:\.\d{1,2})?", q["par_amount"]):
        raise ValueError("Invalid par")
    par = Fraction(q["par_amount"])
    if not 1 <= par <= 1_000_000_000:
        raise ValueError("Par domain")
    name = "z_spread" if "z_spread" in q else "clean_price"
    text = q[name]
    if not isinstance(text, str) or len(text) > 24 or not re.fullmatch(r"-?\d{1,10}(?:\.\d{1,12})?", text):
        raise ValueError("Invalid quote decimal")
    accrued, flows = cash_flows(q["instrument_id"], asof)
    curve = Curve(q["fixture_id"])
    exact_dirty = None
    if name == "z_spread":
        spread = Decimal(text)
        if not Decimal("-0.10") <= spread <= 1:
            raise ValueError("Spread domain")
        dirty, _ = pv_and_slope(curve, flows, asof, spread)
        if all(curve.exponent_exact((d - asof).days, spread) == 0 for d, _ in flows):
            exact_dirty = sum((amount for _, amount in flows), Fraction(0))
    else:
        clean = Fraction(text)
        if not 0 < clean <= 10000:
            raise ValueError("Price domain")
        exact_dirty = clean + accrued
        spread = inverse(curve, flows, asof, exact_dirty)
        dirty = dec(exact_dirty)
    clean_value = dirty - dec(accrued)
    mark = (dirty * dec(par) / 100).quantize(Decimal(".01"), rounding=ROUND_HALF_EVEN)
    if exact_dirty is not None:
        mark_text = rounded_fraction(exact_dirty * par / 100)
    else:
        mark_text = format(mark, ".2f")
    return {
        "dirty": str(dirty), "clean": str(clean_value), "accrued": str(dec(accrued)),
        "spread": str(spread), "mark_value_usd": mark_text,
        "remaining": [{"payment_date": d.isoformat(), "days": (d - asof).days,
                       "discount_factor": str(curve.df((d - asof).days, spread))} for d, _ in flows],
    }


if __name__ == "__main__":
    raw = sys.stdin.buffer.read(1_048_577)
    if len(raw) > 1_048_576:
        raise ValueError("Oracle input limit")
    requests = json.loads(raw)
    if not isinstance(requests, list) or not 1 <= len(requests) <= 256:
        raise ValueError("Oracle request-count limit")
    with localcontext() as context:
        context.prec, context.rounding = 125, ROUND_HALF_EVEN
        print(json.dumps([query(q) for q in requests], separators=(",", ":")))
