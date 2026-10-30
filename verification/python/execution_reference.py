"""Independent standard-library rational oracle. No JS/TS or application projection imports."""
from datetime import date
from fractions import Fraction
import json
import sys


def accrual(revision, settlement):
    d = date.fromisoformat(settlement)
    if not date(2025, 1, 15) <= d < date(2031, 1, 15):
        raise ValueError('Outside approved regular coupon life')
    # Independent chronological literal coupon schedule, including dated date.
    schedule = [date(year, month, 15) for year in range(2025, 2032) for month in (1, 7)]
    before = max(c for c in schedule if c <= d)
    after = min(c for c in schedule if c > d)
    if revision == 'phase1-ust-1':
        return Fraction((d - before).days, (after - before).days)
    if revision == 'phase1-corp-1':
        # US/NASD 30/360: all approved period starts are the 15th.
        elapsed = 360 * (d.year - before.year) + 30 * (d.month - before.month) + d.day - before.day
        return Fraction(elapsed, 180)
    raise ValueError('Unknown instrument revision')


def round_even(rational_cents):
    q, r = divmod(rational_cents.numerator, rational_cents.denominator)
    return q + int(2 * r > rational_cents.denominator or
                   (2 * r == rational_cents.denominator and q % 2 == 1))


def execution_cents(clean, par, revision, settlement):
    # Coupon = 4% annual / 2 * 100 par = 2 per100.
    dirty_per100 = Fraction(clean) + 2 * accrual(revision, settlement)
    return round_even(Fraction(par) * dirty_per100)


def verify(document):
    contract = document['order']['contract']
    assert contract['financial_source'] == '6016fb700840d081fe1fba651c918f0a7e709383'
    assert contract['valuation_model_version'] == 'phase1-regular-coupon-v1'
    cents, par = 0, Fraction(0)
    for sequence, e in enumerate(document['executions'], 1):
        assert e['fill_sequence'] == sequence
        assert e['clean_price'] == contract['clean_price']
        assert e['instrument_revision'] == contract['instrument_revision']
        assert e['settlement_date'] == contract['settlement_date']
        assert e['side'] == contract['side']
        expected = execution_cents(contract['clean_price'], e['par_amount'], contract['instrument_revision'], contract['settlement_date'])
        assert int(e['consideration_cents']) == expected
        cents += expected
        par += Fraction(e['par_amount'])
    assert int(document['lifecycle']['executed_cents']) == cents
    assert Fraction(document['lifecycle']['filled_par']) == par
    assert document['lifecycle']['execution_count'] == len(document['executions'])
    return cents


if __name__ == '__main__':
    print('Independent execution cash verified:', verify(json.load(sys.stdin)))
