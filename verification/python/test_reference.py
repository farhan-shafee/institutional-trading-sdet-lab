"""Literal and structural tests for the independent oracle (stdlib only)."""

from datetime import date
from decimal import Decimal, localcontext
import json
from pathlib import Path
import unittest

from reference import (
    D, PRECISION, MIN_YIELD, MAX_YIELD, fixed, formatted, strict_date,
    us_30_360_days, valuation,
)


GOLDENS = Path(__file__).resolve().parents[2] / "test-data/fixed-income/python-reference-golden.json"


class ReferenceTests(unittest.TestCase):
    def test_frozen_rational_and_analytic_goldens(self):
        cases = json.loads(GOLDENS.read_text())["cases"]
        self.assertEqual(len(cases), 8)
        for case in cases:
            with self.subTest(case=case["name"]):
                actual = valuation(case["instrument_id"], case["settlement_date"]).analytics(
                    D(case["yield"]), D(case["par_amount"])
                )
                self.assertEqual(formatted(actual), case["expected"])

    def test_same_leap_day_has_two_literal_accrued_interest_values(self):
        treasury = valuation("SYN-UST-2031", "2028-02-29")
        corporate = valuation("SYN-CORP-2031", "2028-02-29")
        self.assertEqual(fixed(treasury.accrued_interest, 10), "0.4945054945")
        self.assertEqual(fixed(corporate.accrued_interest, 10), "0.4888888889")
        with localcontext() as ctx:
            ctx.prec = PRECISION
            self.assertEqual(treasury.accrual_fraction, D(45) / 182)
            self.assertEqual(corporate.accrual_fraction, D(44) / 180)

    def test_30_360_february_and_31st_rules(self):
        cases = [
            ("2025-02-28", "2025-03-31", 30),
            ("2028-02-29", "2028-03-31", 30),
            ("2027-02-28", "2028-02-29", 360),
            ("2028-02-29", "2029-02-28", 360),
            ("2025-01-31", "2025-02-28", 28),
            ("2025-08-31", "2025-09-30", 30),
            ("2028-01-15", "2028-02-29", 44),
            ("2025-01-15", "2025-03-31", 76),
        ]
        for first, last, expected in cases:
            with self.subTest(start=first, end=last):
                self.assertEqual(us_30_360_days(strict_date(first), strict_date(last)), expected)

    def test_coupon_day_resets_and_excludes_same_day_payment(self):
        for instrument in ("SYN-UST-2031", "SYN-CORP-2031"):
            before = valuation(instrument, "2025-07-14")
            on_coupon = valuation(instrument, "2025-07-15")
            self.assertGreater(before.accrued_interest, D("1.98"))
            self.assertEqual(on_coupon.accrued_interest, 0)
            self.assertEqual(on_coupon.previous, date(2025, 7, 15))
            self.assertEqual(on_coupon.following, date(2026, 1, 15))
            self.assertEqual(len(on_coupon.remaining), 11)
            self.assertNotIn(date(2025, 7, 15), on_coupon.remaining)
            self.assertEqual(on_coupon.dirty(D(0)), D(122))

    def test_actual_period_denominator_changes_in_leap_year(self):
        self.assertEqual(fixed(valuation("SYN-UST-2031", "2027-02-28").accrued_interest, 10), "0.4861878453")
        self.assertEqual(fixed(valuation("SYN-UST-2031", "2028-02-28").accrued_interest, 10), "0.4835164835")

    def test_strict_gregorian_dates(self):
        self.assertEqual(strict_date("2028-02-29"), date(2028, 2, 29))
        for invalid in ("2025-02-29", "2028-2-29", "2028-02-30", "2028-02-29T00:00:00Z", "0000-01-01", "2028-02-29 "):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                strict_date(invalid)

    def test_maturity_and_dates_outside_lifetime_rejected(self):
        for instrument in ("SYN-UST-2031", "SYN-CORP-2031"):
            for settlement in ("2025-01-14", "2031-01-15", "2032-01-15"):
                with self.subTest(instrument=instrument, settlement=settlement), self.assertRaises(ValueError):
                    valuation(instrument, settlement)

    def test_dated_date_and_last_day_schedule(self):
        initial = valuation("SYN-UST-2031", "2025-01-15")
        final = valuation("SYN-UST-2031", "2031-01-14")
        self.assertEqual(initial.previous, date(2025, 1, 15))
        self.assertEqual(len(initial.remaining), 12)
        self.assertEqual(final.remaining, (date(2031, 1, 15),))

    def test_par_price_at_coupon_yield(self):
        for instrument in ("SYN-UST-2031", "SYN-CORP-2031"):
            for settlement in ("2025-01-15", "2025-07-15", "2030-07-15"):
                with self.subTest(instrument=instrument, settlement=settlement):
                    price = valuation(instrument, settlement).clean(D("0.04"))
                    self.assertLess(abs(price - 100), D("1e-65"))

    def test_negative_yield_literal_price_and_inverse(self):
        bond = valuation("SYN-CORP-2031", "2025-01-15")
        self.assertEqual(fixed(bond.clean(D("-0.02")), 10), "138.4534298506")
        solved = bond.yield_for_clean(D("138.4534298506"))
        self.assertEqual(fixed(solved, 12), "-0.020000000000")
        self.assertLess(abs(bond.clean(solved) - D("138.4534298506")), D("1e-50"))

    def test_newton_inverse_for_exact_market_input(self):
        bond = valuation("SYN-UST-2031", "2028-02-29")
        for market in ("95", "100.1234567890", "110", "120"):
            with self.subTest(market=market):
                solved = bond.yield_for_clean(D(market))
                self.assertLess(abs(bond.clean(solved) - D(market)), D("1e-50"))

    def test_inclusive_yield_boundaries_and_boundary_repricing(self):
        bond = valuation("SYN-UST-2031", "2025-01-15")
        for annual in (MIN_YIELD, MAX_YIELD):
            with self.subTest(annual=annual):
                result = bond.analytics(annual, D("1000000000"))
                self.assertGreater(result["dv01_usd"], 0)
                self.assertEqual(bond.yield_for_clean(bond.clean(annual)), annual)

    def test_price_outside_yield_bracket_rejected(self):
        bond = valuation("SYN-CORP-2031", "2031-01-14")
        for market in ("0", "0.01", "10000", "10000.01", "NaN"):
            with self.subTest(market=market), self.assertRaises(ValueError):
                bond.yield_for_clean(D(market))

    def test_endpoint_wire_price_roundtrips(self):
        for instrument in ("SYN-UST-2031", "SYN-CORP-2031"):
            bond = valuation(instrument, "2025-01-15")
            for annual in (MIN_YIELD, MAX_YIELD):
                with self.subTest(instrument=instrument, annual=annual):
                    quote = D(fixed(bond.clean(annual), 10))
                    solved = bond.yield_for_clean(quote)
                    self.assertEqual(fixed(solved, 12), fixed(annual, 12))

    def test_risk_against_exact_zero_yield_derivatives(self):
        bond = valuation("SYN-UST-2031", "2025-01-15")
        first, second = bond.derivatives(D(0))
        self.assertLess(abs(first - D(-678)), D("1e-18"))
        self.assertLess(abs(second - D(4264)), D("1e-18"))

    def test_par_range_scale_and_yield_range(self):
        bond = valuation("SYN-UST-2031", "2025-01-15")
        for par in ("0.99", "1000000000.01", "1.001", "Infinity"):
            with self.subTest(par=par), self.assertRaises(ValueError):
                bond.analytics(D("0.04"), D(par))
        for annual in ("-0.1000001", "1.0000001", "NaN"):
            with self.subTest(annual=annual), self.assertRaises(ValueError):
                bond.analytics(D(annual), D(100))

    def test_half_even_formatting(self):
        self.assertEqual(fixed(D("1.005"), 2), "1.00")
        self.assertEqual(fixed(D("1.015"), 2), "1.02")
        self.assertEqual(fixed(D("1.00000000005"), 10), "1.0000000000")
        self.assertEqual(fixed(D("1.00000000015"), 10), "1.0000000002")

    def test_exact_quote_consideration_half_cent_ties(self):
        bond = valuation("SYN-UST-2031", "2025-07-16")
        annual = bond.yield_for_clean(D(100))
        # Exact accrual is 2/184, rather than any finite Decimal expansion.
        # (100 + 2/184) * 46/100 = 46.005, with an even lower cent.
        # (100 + 2/184) * 138/100 = 138.015, with an odd lower cent.
        for par, expected in (("46", "46.00"), ("138", "138.02")):
            with self.subTest(par=par):
                actual = bond.analytics(annual, D(par), market_clean=D(100))
                self.assertEqual(fixed(actual["consideration_usd"], 2), expected)

    def test_exact_coupon_yield_consideration_half_cent_ties(self):
        bond = valuation("SYN-UST-2031", "2030-07-15")
        # The only remaining payment has exact PV 102/1.04 = 1275/13.
        # The amounts are exactly 1.275 and 1.785, respectively.
        for par, expected in (("1.30", "1.28"), ("1.82", "1.78")):
            with self.subTest(par=par):
                actual = bond.analytics(D("0.08"), D(par))
                self.assertEqual(fixed(actual["consideration_usd"], 2), expected)

    def test_exact_fractional_power_consideration_half_cent_ties(self):
        bond = valuation("SYN-UST-2031", "2030-10-15")
        self.assertEqual((bond.accrual_days, bond.accrual_period_days), (92, 184))
        # sqrt(1 + .1632/2) = 1.04 exactly: this half-period discount
        # therefore has the same rational PV 1275/13 as the preceding test.
        for par, expected in (("1.30", "1.28"), ("1.82", "1.78")):
            with self.subTest(par=par):
                actual = bond.analytics(D("0.1632"), D(par))
                self.assertEqual(fixed(actual["consideration_usd"], 2), expected)


if __name__ == "__main__":
    unittest.main()
