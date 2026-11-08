"""Independent125-digit risk repricing from written Phase4C conventions."""
from datetime import date
from decimal import Decimal, localcontext, ROUND_HALF_EVEN
from fractions import Fraction
from functools import lru_cache
import json
import re
import sys
from curves import Curve, RATES, OFFSETS, IDS, DATED, MATURITY, cash_flows, dec

SCENARIOS = {
    "PARALLEL_UP_100": (100, 100, 100, 100),
    "PARALLEL_DOWN_100": (-100, -100, -100, -100),
    "STEEPENER_V1": (-50, -25, 25, 50),
}


class ShockCurve(Curve):
    def __init__(self, fixture, bumps):
        rates = [Fraction(rate) + Fraction(bp, 10000)
                 for rate, bp in zip(RATES[fixture], bumps)]
        self.points = [(0, Decimal(0))] + [
            (days, -dec(rate) * days / 365) for days, rate in zip(OFFSETS, rates)]
        self.exact = [(0, Fraction(0))] + [
            (days, -rate * days / 365) for days, rate in zip(OFFSETS, rates)]


@lru_cache(maxsize=64)
def unit_risk(fixture, instrument, asof_text):
    asof = date.fromisoformat(asof_text)
    _, future = cash_flows(instrument, asof)

    def pv(bumps):
        curve = ShockCurve(fixture, bumps)
        return sum((dec(amount) * curve.df((payment - asof).days, Decimal(0))
                    for payment, amount in future), Decimal(0))

    base = pv((0, 0, 0, 0))
    parallel = (pv((-1, -1, -1, -1)) - pv((1, 1, 1, 1))) / 2
    keys = []
    for i in range(4):
        down, up = [0] * 4, [0] * 4
        down[i], up[i] = -1, 1
        keys.append((pv(down) - pv(up)) / 2)
    stresses = {name: pv(bumps) - base for name, bumps in SCENARIOS.items()}
    return base, parallel, tuple(keys), stresses


def query(q):
    if set(q) != {"fixture_id", "instrument_id", "as_of_date", "signed_par"}:
        raise ValueError("Unexpected oracle fields")
    if q["fixture_id"] not in RATES or q["instrument_id"] not in IDS:
        raise ValueError("Unsupported definition")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", q["as_of_date"]):
        raise ValueError("Invalid date")
    if not DATED <= date.fromisoformat(q["as_of_date"]) < MATURITY:
        raise ValueError("Date domain")
    if not re.fullmatch(r"-?\d{1,10}(?:\.\d{1,2})?", q["signed_par"]):
        raise ValueError("Signed par grammar")
    par = Decimal(q["signed_par"])
    if abs(par) > Decimal("8000000000"):
        raise ValueError("Signed par domain")
    base, parallel, keys, stresses = unit_risk(q["fixture_id"], q["instrument_id"], q["as_of_date"])
    factor = par / 100
    mark = (base * factor).quantize(Decimal(".01"), rounding=ROUND_HALF_EVEN)
    return {
        "pv": str(base * factor), "parallel_dv01": str(parallel * factor),
        "key_rate_dv01": [str(value * factor) for value in keys],
        "stress_pnl": {name: str(value * factor) for name, value in stresses.items()},
        "pv_usd": "0.00" if mark.is_zero() else format(mark, ".2f"),
    }


if __name__ == "__main__":
    raw = sys.stdin.buffer.read(1_048_577)
    if len(raw) > 1_048_576:
        raise ValueError("Input limit")
    requests = json.loads(raw)
    if not isinstance(requests, list) or not 1 <= len(requests) <= 128:
        raise ValueError("Request-count limit")
    with localcontext() as context:
        context.prec, context.rounding = 125, ROUND_HALF_EVEN
        print(json.dumps([query(q) for q in requests], separators=(",", ":")))
