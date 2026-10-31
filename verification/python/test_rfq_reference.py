"""Literal quote expectations independent of SQL and TypeScript."""
import unittest
from decimal import Decimal
from rfq_reference import expected_prices, verify_order


class DealerReferenceTests(unittest.TestCase):
    def test_literal_prices_and_sub_display_precision(self):
        self.assertEqual(expected_prices("SYN-UST-2031", "ATLAS"), ("99.950000000123", "100.050000000123"))
        self.assertEqual(expected_prices("SYN-CORP-2031", "CEDAR"), ("98.930000000123", "99.070000000123"))
        self.assertNotEqual(Decimal("100.050000000123"), Decimal("100.05"))

    def test_wrong_side_and_display_rounding_are_rejected(self):
        contract = {"instrument_id": "SYN-UST-2031", "dealer_id": "ATLAS", "side": "BUY", "clean_price": "99.950000000123"}
        with self.assertRaises(ValueError):
            verify_order(contract)
        contract["clean_price"] = "100.05"
        with self.assertRaises(ValueError):
            verify_order(contract)

    def test_buy_sell_literal_values(self):
        for side, price in (("BUY", "100.050000000123"), ("SELL", "99.950000000123")):
            verify_order({"instrument_id": "SYN-UST-2031", "dealer_id": "ATLAS", "side": side, "clean_price": price})


if __name__ == "__main__":
    unittest.main()
