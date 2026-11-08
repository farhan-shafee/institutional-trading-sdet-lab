"""Independent oracle from docs/PHASE4_ECONOMICS.md; no application imports.
Fractions remain exact through inverse/simple-discount and cash rounding.
"""
from datetime import date
from fractions import Fraction
import json
import sys

def fixed(value, places):
    scaled = value * 10 ** places
    integer, remainder = divmod(abs(scaled.numerator), scaled.denominator)
    if 2 * remainder > scaled.denominator or (2 * remainder == scaled.denominator and integer % 2):
        integer += 1
    sign = "-" if value < 0 and integer else ""
    whole, fraction = divmod(integer, 10 ** places)
    return f"{sign}{whole}.{fraction:0{places}d}"

def calculate(q):
    days = (date(2031, 1, 15) - date.fromisoformat(q["settlement_date"])).days
    time = Fraction(days, 365)
    par = Fraction(q["par_amount"])
    if "yield" in q:
        rate = Fraction(q["yield"])
        price = 100 / (1 + rate * time)
    else:
        price = Fraction(q["clean_price"])
        rate = (100 / price - 1) / time
        if rate < Fraction(-1, 10) and price - 100 / (1 - time / 10) <= Fraction(1, 20000000000):
            rate = Fraction(-1, 10)
        if rate > 1 and 100 / (1 + time) - price <= Fraction(1, 20000000000):
            rate = Fraction(1)
    return {
        "days_to_maturity": days,
        "time_to_maturity_years": fixed(time, 12),
        "par_amount": fixed(par, 2),
        "yield": fixed(rate, 12),
        "clean_price": fixed(price, 10),
        "dirty_price": fixed(price, 10),
        "accrued_interest": "0.0000000000",
        "consideration_usd": fixed(price * par / 100, 2),
    }

if __name__ == "__main__":
    requests = json.load(sys.stdin)
    print(json.dumps([calculate(q) for q in requests], sort_keys=True))
