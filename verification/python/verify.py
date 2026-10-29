#!/usr/bin/env python3
"""Compare a local, disposable TradeFlow HTTP service to an independent oracle.

This command never starts infrastructure and refuses non-loopback URLs. The
caller owns the local server. It creates one in-memory session and deletes that
session in finally. No application code or application calculation is imported.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import io
import json
from pathlib import Path
import re
import sys
import unittest
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from reference import D, INSTRUMENTS, PRECISION, SCALES, fixed, formatted, valuation


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
GOLDENS = ROOT / "test-data/fixed-income/python-reference-golden.json"


class VerificationFailure(AssertionError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise VerificationFailure(message)


def loopback_url(value: str) -> str:
    parts = urlsplit(value)
    try:
        port = parts.port
    except ValueError as exc:
        raise argparse.ArgumentTypeError("invalid loopback port") from exc
    if (
        parts.scheme != "http"
        or parts.hostname not in {"127.0.0.1", "localhost", "::1"}
        or parts.username is not None
        or parts.password is not None
        or port is None
        or not 1 <= port <= 65535
        or parts.path not in {"", "/"}
        or parts.query
        or parts.fragment
    ):
        raise argparse.ArgumentTypeError("base URL must be an explicit http loopback origin with a port")
    return value.rstrip("/")


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise VerificationFailure("HTTP redirects are forbidden in local verification")


class Client:
    def __init__(self, origin: str):
        # Disable ambient proxy configuration; all requests stay on loopback.
        self.origin = origin
        self.opener = build_opener(ProxyHandler({}), NoRedirects())
        self.token: str | None = None

    def request(self, method: str, path: str, body=None, authenticated=True):
        require(path.startswith("/api/") and not path.startswith("//"), "API path required")
        headers = {"Accept": "application/json"}
        if authenticated and self.token:
            headers["Authorization"] = "Bearer " + self.token
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(self.origin + path, method=method, data=data, headers=headers)
        try:
            with self.opener.open(request, timeout=10) as response:
                status, raw = response.status, response.read()
        except HTTPError as response:
            status, raw = response.code, response.read()
        if not raw:
            return status, None
        try:
            return status, json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise VerificationFailure(f"{method} {path.split('?')[0]} returned invalid JSON ({status})") from exc


def check_instrument(actual: object, instrument_id: str) -> None:
    require(isinstance(actual, dict), "instrument must be an object")
    expected = {
        "id": instrument_id,
        "currency": "USD",
        "dated_date": "2025-01-15",
        "maturity_date": "2031-01-15",
        "frequency": 2,
        "day_count": INSTRUMENTS[instrument_id],
        "fictional": True,
    }
    for key, value in expected.items():
        require(actual.get(key) == value, f"instrument.{key}: expected {value!r}, received {actual.get(key)!r}")
    require(isinstance(actual.get("issuer"), str) and bool(actual["issuer"].strip()), "instrument issuer is required")
    require(isinstance(actual.get("coupon_rate"), str), "coupon rate must be a decimal string")
    try:
        rate = D(actual["coupon_rate"])
    except InvalidOperation as exc:
        raise VerificationFailure("coupon rate is not a decimal") from exc
    require(rate.is_finite() and rate == D("0.04"), "coupon rate must equal annual 0.04")


def check_analytics(actual: object, case: dict, expected: dict[str, str]) -> None:
    require(isinstance(actual, dict), "analytics response must be an object")
    bond = valuation(case["instrument_id"], case["settlement_date"])
    check_instrument(actual.get("instrument"), case["instrument_id"])
    require(actual.get("settlement_date") == case["settlement_date"], "settlement date mismatch")
    require(isinstance(actual.get("par_amount"), str), "par amount must be a decimal string")
    require(re.fullmatch(r"[0-9]+(?:\.[0-9]{1,2})?", actual["par_amount"]) is not None, "invalid par output format")
    require(D(actual["par_amount"]) == D(case["par_amount"]), "par amount mismatch")
    for key, scale in SCALES.items():
        output = actual.get(key)
        require(isinstance(output, str), f"{key} must be a decimal string")
        require(re.fullmatch(rf"-?[0-9]+\.[0-9]{{{scale}}}", output) is not None, f"{key} must have exactly {scale} decimal places")
        require(output == expected[key], f"{key}: expected {expected[key]}, received {output}")
    require(actual.get("previous_coupon_date") == bond.previous.isoformat(), "previous coupon mismatch")
    require(actual.get("next_coupon_date") == bond.following.isoformat(), "next coupon mismatch")
    require(actual.get("remaining_coupon_dates") == [item.isoformat() for item in bond.remaining], "remaining coupons mismatch")
    require(isinstance(actual.get("conventions"), dict) and bool(actual["conventions"]), "conventions must be a nonempty object")


def make_cases() -> list[dict]:
    yield_inputs = [
        ("2025-01-15", "-0.10", "1"),
        ("2025-01-15", "0", "100"),
        ("2025-01-15", "0.04", "1000.01"),
        ("2025-01-15", "1.00", "1000000000"),
        ("2025-07-14", "0.04", "1000000"),
        ("2025-07-15", "0.04", "1000000"),
        ("2028-02-28", "-0.025", "250000.25"),
        ("2028-02-29", "0.0875", "1000000.00"),
        ("2028-03-01", "0.04", "1"),
        ("2030-07-15", "-0.10", "1000000"),
        ("2031-01-14", "-0.10", "1000000"),
        ("2031-01-14", "1.00", "1000000000"),
    ]
    inverse_inputs = [
        ("2025-01-15", "-0.10", "1000000000"),
        ("2025-01-15", "1.00", "1000000000"),
        ("2025-01-15", "-0.075", "1000000"),
        ("2025-07-14", "0.0425", "1000000.25"),
        ("2025-07-15", "0.04", "100"),
        ("2028-02-29", "0.0875", "1000000"),
        ("2030-07-15", "0.999", "1000000000"),
        ("2031-01-14", "-0.05", "1"),
    ]
    cases = []
    for instrument_id in INSTRUMENTS:
        for index, (settlement, annual, par) in enumerate(yield_inputs):
            cases.append({"name": f"yield-{instrument_id}-{index + 1}", "instrument_id": instrument_id,
                          "settlement_date": settlement, "par_amount": par, "yield": annual})
        for index, (settlement, annual, par) in enumerate(inverse_inputs):
            # The rounded quote becomes the exact market input to the inverse.
            # We never compare against the seed yield used to construct it.
            quote = fixed(valuation(instrument_id, settlement).clean(D(annual)), 10)
            cases.append({"name": f"inverse-{instrument_id}-{index + 1}", "instrument_id": instrument_id,
                          "settlement_date": settlement, "par_amount": par, "clean_price": quote})
    cases.extend(json.loads(GOLDENS.read_text())["cases"])
    for par, expected in (("46", "46.00"), ("138", "138.02")):
        cases.append({"name": f"quote-half-cent-{par}", "instrument_id": "SYN-UST-2031",
                      "settlement_date": "2025-07-16", "par_amount": par, "clean_price": "100",
                      "cash_expected": expected})
    for par, expected in (("1.30", "1.28"), ("1.82", "1.78")):
        cases.append({"name": f"coupon-yield-half-cent-{par}", "instrument_id": "SYN-UST-2031",
                      "settlement_date": "2030-07-15", "par_amount": par, "yield": "0.08",
                      "cash_expected": expected})
        cases.append({"name": f"fractional-yield-half-cent-{par}", "instrument_id": "SYN-UST-2031",
                      "settlement_date": "2030-10-15", "par_amount": par, "yield": "0.1632",
                      "cash_expected": expected})
    return cases


def verify_http(client: Client, results: list[dict]) -> None:
    def record(name, check, kind="contract"):
        try:
            check()
            results.append({"name": name, "kind": kind, "passed": True})
        except Exception as exc:
            results.append({"name": name, "kind": kind, "passed": False,
                            "error": f"{type(exc).__name__}: {exc}"})

    for path in ("/api/fixed-income/v1/instruments", "/api/fixed-income/v1/analytics"):
        def unauthenticated(path=path):
            status, _ = client.request("GET", path, authenticated=False)
            require(status == 401, f"unauthenticated request expected 401, received {status}")
        record("authentication-" + path.rsplit("/", 1)[-1], unauthenticated)

    status, login = client.request("POST", "/api/session", {"username": "qa.user", "password": "Password123!"}, authenticated=False)
    require(status == 200 and isinstance(login, dict) and isinstance(login.get("token"), str) and bool(login["token"]), "local test session could not be created")
    client.token = login["token"]
    # Once a token exists, every subsequent operation is inside cleanup.
    try:
        def instruments():
            code, body = client.request("GET", "/api/fixed-income/v1/instruments")
            require(code == 200 and isinstance(body, dict) and isinstance(body.get("instruments"), list), "instrument listing failed")
            listing = body["instruments"]
            require(len(listing) == 2 and {item.get("id") for item in listing if isinstance(item, dict)} == set(INSTRUMENTS), "expected exactly the two synthetic instruments")
            for item in listing:
                check_instrument(item, item["id"])
        record("instrument-contract", instruments)

        for case in make_cases():
            def financial_case(case=case):
                bond = valuation(case["instrument_id"], case["settlement_date"])
                annual = D(case["yield"]) if "yield" in case else bond.yield_for_clean(D(case["clean_price"]))
                market = D(case["clean_price"]) if "clean_price" in case else None
                values = bond.analytics(annual, D(case["par_amount"]), market_clean=market)
                expected = formatted(values)
                if "cash_expected" in case:
                    require(expected["consideration_usd"] == case["cash_expected"],
                            "exact reference disagrees with literal half-cent tie")
                if "expected" in case:
                    require(expected == case["expected"], "independent oracle no longer matches frozen literal golden")
                    expected = case["expected"]
                params = {key: case[key] for key in ("instrument_id", "settlement_date", "par_amount")}
                params["yield" if "yield" in case else "clean_price"] = case.get("yield", case.get("clean_price"))
                code, body = client.request("GET", "/api/fixed-income/v1/analytics?" + urlencode(params))
                require(code == 200, f"analytics expected 200, received {code}")
                check_analytics(body, case, expected)
                if "clean_price" in case:
                    require(body["clean_price"] == fixed(D(case["clean_price"]), 10), "inverse must reproduce exact market quote")
            kind = "golden" if "expected" in case else ("inverse" if "clean_price" in case else "yield")
            record(case["name"], financial_case, kind)

        default = {"instrument_id": "SYN-UST-2031", "settlement_date": "2028-02-29", "par_amount": "1000000", "yield": "0.04"}
        invalid = [
            ("maturity-excluded", {"settlement_date": "2031-01-15"}),
            ("before-dated-date", {"settlement_date": "2025-01-14"}),
            ("invalid-leap-date", {"settlement_date": "2025-02-29"}),
            ("yield-below-bound", {"yield": "-0.100000000001"}),
            ("yield-above-bound", {"yield": "1.000000000001"}),
            ("par-below-bound", {"par_amount": "0.99"}),
            ("par-above-bound", {"par_amount": "1000000000.01"}),
            ("par-excess-scale", {"par_amount": "100.001"}),
            ("unknown-field", {"surprise": "1"}),
        ]
        for name, override in invalid:
            def invalid_case(override=override):
                code, _ = client.request("GET", "/api/fixed-income/v1/analytics?" + urlencode(default | override))
                require(code == 400, f"invalid query expected 400, received {code}")
            record(name, invalid_case)
        for name, quote in (("price-too-high-for-bracket", "10000"), ("price-too-low-for-bracket", "0.01")):
            def out_of_bracket(quote=quote):
                params = {key: value for key, value in default.items() if key != "yield"}
                params["clean_price"] = quote
                code, _ = client.request("GET", "/api/fixed-income/v1/analytics?" + urlencode(params))
                require(code == 400, f"unbracketed price expected 400, received {code}")
            record(name, out_of_bracket)
        def duplicate_query():
            code, _ = client.request("GET", "/api/fixed-income/v1/analytics?" + urlencode(default) + "&yield=0.05")
            require(code == 400, f"repeated query expected 400, received {code}")
        record("repeated-field", duplicate_query)
    finally:
        try:
            code, _ = client.request("DELETE", "/api/session")
            require(code == 204, f"session cleanup expected 204, received {code}")
            results.append({"name": "ephemeral-session-deleted", "kind": "cleanup", "passed": True})
        except Exception as exc:
            results.append({"name": "ephemeral-session-deleted", "kind": "cleanup", "passed": False,
                            "error": f"{type(exc).__name__}: {exc}"})
        finally:
            client.token = None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", type=loopback_url, required=True)
    parser.add_argument("--summary", type=Path, help="also write machine-readable results to this JSON path")
    args = parser.parse_args()
    started = datetime.now(timezone.utc).isoformat()
    unit_output = io.StringIO()
    suite = unittest.defaultTestLoader.discover(str(HERE), pattern="test_*.py")
    unit_result = unittest.TextTestRunner(stream=unit_output, verbosity=1).run(suite)
    results: list[dict] = []
    if unit_result.wasSuccessful():
        try:
            verify_http(Client(args.base_url), results)
        except Exception as exc:
            results.append({"name": "http-verifier", "kind": "fatal", "passed": False,
                            "error": f"{type(exc).__name__}: {exc}"})
    passed = unit_result.wasSuccessful() and bool(results) and all(item["passed"] for item in results)
    summary = {
        "schema_version": 1,
        "passed": passed,
        "started_at": started,
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "oracle": {"source": "Phase 1 written convention contract only", "decimal_precision": PRECISION,
                   "inverse_method": "safeguarded Newton/secant", "risk_method": "five-point finite difference with Richardson convergence check",
                   "cash_rounding_method": "exact Fraction quote/accrual; exact integer-power comparison for fractional yield cash",
                   "imports_application_code": False},
        "unit_tests": {"run": unit_result.testsRun, "failures": len(unit_result.failures),
                       "errors": len(unit_result.errors), "passed": unit_result.wasSuccessful()},
        "http": {"cases": len(results), "passed": sum(item["passed"] for item in results),
                 "financial_cases": sum(item["kind"] in {"yield", "inverse", "golden"} for item in results),
                 "results": results},
    }
    if not unit_result.wasSuccessful():
        summary["unit_tests"]["details"] = unit_output.getvalue()
    payload = json.dumps(summary, indent=2, sort_keys=True) + "\n"
    if args.summary:
        args.summary.write_text(payload, encoding="utf-8")
    sys.stdout.write(payload)
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
