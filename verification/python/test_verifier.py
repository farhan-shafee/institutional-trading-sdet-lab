"""Safety checks for the HTTP harness, independent of application code."""

import argparse
import unittest
from unittest.mock import patch

from verify import Client, NoRedirects, VerificationFailure, loopback_url, make_cases, verify_http


class VerifierTests(unittest.TestCase):
    def test_only_explicit_loopback_origins_accepted(self):
        for value in ("http://127.0.0.1:3000", "http://localhost:3000/", "http://[::1]:3000"):
            with self.subTest(value=value):
                self.assertEqual(loopback_url(value), value.rstrip("/"))
        for value in (
            "https://127.0.0.1:3000", "http://example.com:3000", "http://127.0.0.2:3000",
            "http://localhost", "http://localhost:0", "http://localhost:99999",
            "http://localhost:3000/api", "http://localhost:3000?x=y", "http://localhost:3000#fragment",
            "http://user@localhost:3000", "http://localhost.evil.example:3000",
        ):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                loopback_url(value)

    def test_redirects_never_followed(self):
        with self.assertRaises(VerificationFailure):
            NoRedirects().redirect_request(None, None, 302, "redirect", {}, "http://example.com")

    def test_verifier_coverage_includes_both_instruments_and_inversion(self):
        cases = make_cases()
        self.assertEqual(len(cases), 54)
        self.assertEqual({case["instrument_id"] for case in cases}, {"SYN-UST-2031", "SYN-CORP-2031"})
        self.assertEqual(sum("clean_price" in case for case in cases), 18)
        self.assertEqual(sum("expected" in case for case in cases), 8)
        self.assertEqual(sum("cash_expected" in case for case in cases), 6)

    def test_session_cleanup_occurs_on_unexpected_verifier_failure(self):
        class FakeLocalClient:
            token = None
            deleted = 0

            def request(self, method, path, body=None, authenticated=True):
                if method == "POST":
                    return 200, {"token": "in-memory-test-token"}
                if method == "DELETE":
                    self.deleted += 1
                    return 204, None
                if not authenticated:
                    return 401, {}
                return 500, {}

        client = FakeLocalClient()
        results = []
        with patch("verify.make_cases", side_effect=RuntimeError("injected failure")):
            with self.assertRaisesRegex(RuntimeError, "injected failure"):
                verify_http(client, results)
        self.assertEqual(client.deleted, 1)
        self.assertIsNone(client.token)
        self.assertTrue(any(item["name"] == "ephemeral-session-deleted" and item["passed"] for item in results))


if __name__ == "__main__":
    unittest.main()
