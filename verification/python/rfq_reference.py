"""Independent literal dealer-price and contractual order oracle. No app/SQL imports."""
from decimal import Decimal, localcontext
import json
import sys
from reference import valuation

PRICES = {
    ("SYN-UST-2031", "ATLAS"): ("99.950000000123", "100.050000000123"),
    ("SYN-UST-2031", "BIRCH"): ("99.940000000123", "100.060000000123"),
    ("SYN-UST-2031", "CEDAR"): ("99.930000000123", "100.070000000123"),
    ("SYN-CORP-2031", "ATLAS"): ("98.950000000123", "99.050000000123"),
    ("SYN-CORP-2031", "BIRCH"): ("98.940000000123", "99.060000000123"),
    ("SYN-CORP-2031", "CEDAR"): ("98.930000000123", "99.070000000123"),
}


def expected_prices(instrument, dealer):
    return PRICES[instrument, dealer]


def verify_order(contract):
    bid, ask = expected_prices(contract["instrument_id"], contract["dealer_id"])
    if contract.get("side") not in ("BUY", "SELL"):
        raise ValueError("invalid contractual side")
    if contract.get("clean_price") != (ask if contract["side"] == "BUY" else bid):
        raise ValueError("contractual price/side mismatch")


def verify_document(document):
    rfq, order = document["rfq"], document["order"]
    if rfq["state"] != "ACCEPTED" or order["status"] != "PENDING_ACK":
        raise ValueError("not an accepted pending order")
    contract = order["contract"]
    verify_order(contract)
    quote = next(q for q in document["quotes"] if q["id"] == order["quote_id"])
    for q in document["quotes"]:
        if (q["bid_clean_price"], q["ask_clean_price"]) != expected_prices(rfq["instrument_id"], q["dealer_id"]):
            raise ValueError("dealer literal mismatch")
    if contract != {**quote["snapshot"], "clean_price": contract["clean_price"]}:
        raise ValueError("quotation snapshot changed")
    for key in ("side", "instrument_id", "instrument_revision", "settlement_date", "par_amount"):
        if contract[key] != rfq[key]:
            raise ValueError("economic propagation mismatch")
    expected_revision = "phase1-ust-1" if rfq["instrument_id"] == "SYN-UST-2031" else "phase1-corp-1"
    if contract["instrument_revision"] != expected_revision or contract["model_version"] != "synthetic-dealer-grid-v1":
        raise ValueError("model/revision mismatch")
    if contract["valuation_model_version"] != "phase1-regular-coupon-v1":
        raise ValueError("valuation model changed")
    if contract["financial_source"] != "6016fb700840d081fe1fba651c918f0a7e709383":
        raise ValueError("financial source changed")
    v = valuation(rfq["instrument_id"], rfq["settlement_date"])
    with localcontext() as ctx:
        ctx.prec = 72
        clean = Decimal(contract["clean_price"])
        y = v.yield_for_clean(clean)
        if abs(v.clean(y) - clean) > Decimal("1e-40"):
            raise ValueError("independent financial inversion mismatch")
        if contract["instrument_terms"]["day_count"] != ("ACT_ACT_ICMA" if rfq["instrument_id"] == "SYN-UST-2031" else "THIRTY_360_US"):
            raise ValueError("day-count convention changed")


if __name__ == "__main__":
    try:
        verify_document(json.load(sys.stdin))
    except (ValueError, KeyError, StopIteration, ArithmeticError):
        print("Independent RFQ financial verification failed; input omitted.", file=sys.stderr)
        sys.exit(1)
    print("Independent RFQ literal prices, side, frozen terms and financial inversion verified.")
