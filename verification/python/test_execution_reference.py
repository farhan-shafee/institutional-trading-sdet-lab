import unittest
from fractions import Fraction
from execution_reference import accrual, execution_cents, round_even

class ExecutionReferenceTests(unittest.TestCase):
    def test_actual_actual_differs_from_us_360_on_leap_day(self):
        self.assertEqual(accrual('phase1-ust-1', '2028-02-29'), Fraction(45, 182))
        self.assertEqual(accrual('phase1-corp-1', '2028-02-29'), Fraction(44, 180))
    def test_coupon_and_last_day(self):
        for revision in ('phase1-ust-1', 'phase1-corp-1'):
            self.assertEqual(accrual(revision, '2028-07-15'), 0)
            self.assertGreater(accrual(revision, '2031-01-14'), Fraction(9, 10))
        with self.assertRaises(ValueError):
            accrual('phase1-ust-1', '2031-01-15')
    def test_half_even_ties_and_neighbours(self):
        self.assertEqual(round_even(Fraction(201, 2)), 100)
        self.assertEqual(round_even(Fraction(203, 2)), 102)
        self.assertEqual(round_even(Fraction(100499999, 1000000)), 100)
        self.assertEqual(round_even(Fraction(100500001, 1000000)), 101)
    def test_partial_rounding_differs_from_whole(self):
        cents = lambda par: execution_cents('100.050000000123', par, 'phase1-ust-1', '2028-01-15')
        self.assertEqual(cents('50.00'), 5003)
        self.assertEqual(cents('100.00'), 10005)
        self.assertEqual(2 * cents('50.00') - cents('100.00'), 1)
    def test_two_day_counts_have_literal_cash(self):
        self.assertEqual(execution_cents('100.050000000123', '100.00', 'phase1-ust-1', '2028-02-29'), 10054)
        self.assertEqual(execution_cents('98.950000000123', '100.00', 'phase1-corp-1', '2028-02-29'), 9944)

if __name__ == '__main__':
    unittest.main()
