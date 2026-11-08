"""Independent exact dirty-basis FIFO reconstruction using Python Fraction/deques."""
from collections import deque
from datetime import date
from fractions import Fraction
import json
import re
import sys
import uuid

IDS = ("SYN-UST-2031", "SYN-CORP-2031")
VERSIONS = {"SYN-UST-2031": "phase1-ust-1", "SYN-CORP-2031": "phase1-corp-1"}
FIELDS = {"execution_id", "command_seq", "instrument_id", "definition_version", "side",
          "par_amount", "consideration_cents", "value_date", "revision"}


def pair(number):
    return [str(number.numerator), str(number.denominator)]


def reconstruct(entries):
    if not isinstance(entries, list) or len(entries) > 8:
        raise ValueError("Root limit")
    normalized = []
    seen = set()
    for item in entries:
        if set(item) != FIELDS or item["instrument_id"] not in IDS:
            raise ValueError("Invalid root")
        instrument = item["instrument_id"]
        if item["definition_version"] != VERSIONS[instrument] or item["side"] not in ("BUY", "SELL"):
            raise ValueError("Wrong definition/side")
        root = str(uuid.UUID(item["execution_id"]))
        if root in seen:
            raise ValueError("Duplicate root")
        seen.add(root)
        if not re.fullmatch(r"[1-9][0-9]{0,2}", item["command_seq"]):
            raise ValueError("Sequence grammar")
        seq = int(item["command_seq"])
        if seq > 512 or type(item["revision"]) is not int or not 0 <= item["revision"] <= 2:
            raise ValueError("Sequence/revision domain")
        if not re.fullmatch(r"\d{1,10}(?:\.\d{1,2})?", item["par_amount"]):
            raise ValueError("Par grammar")
        quantity = Fraction(item["par_amount"])
        if not Fraction(1, 100) <= quantity <= 1_000_000_000:
            raise ValueError("Par range")
        if not re.fullmatch(r"0|[1-9][0-9]{0,13}", item["consideration_cents"]):
            raise ValueError("Cash grammar")
        cents = int(item["consideration_cents"])
        if cents > 10_002_000_000_000:
            raise ValueError("Cash range")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", item["value_date"]):
            raise ValueError("Value date")
        if not date(2025, 1, 15) <= date.fromisoformat(item["value_date"]) < date(2031, 1, 15):
            raise ValueError("Value date range")
        normalized.append((seq, root, instrument, 1 if item["side"] == "BUY" else -1,
                           quantity, Fraction(cents, 100)))
    normalized.sort(key=lambda value: (value[0], value[1]))
    books = {instrument: deque() for instrument in IDS}
    positions = {}
    realized = Fraction(0)
    order = {}
    for seq, root, instrument, direction, quantity, cash in normalized:
        order[root] = (seq, root)
        positions[instrument] = positions.get(instrument, Fraction(0)) + direction * quantity
        remaining = quantity
        queue = books[instrument]
        while remaining and queue and queue[0]["direction"] != direction:
            lot = queue[0]
            matched = min(remaining, lot["quantity"])
            old_value = lot["amount"] * matched / lot["quantity"]
            new_value = cash * matched / quantity
            realized += (new_value - old_value) * lot["direction"]
            remaining -= matched
            lot["quantity"] -= matched
            lot["amount"] -= old_value
            if not lot["quantity"]:
                queue.popleft()
        if remaining:
            queue.append({"root": root, "instrument": instrument, "direction": direction,
                          "quantity": remaining, "amount": cash * remaining / quantity})
    all_lots = sorted([lot for queue in books.values() for lot in queue],
                      key=lambda lot: order[lot["root"]])
    for instrument in IDS:
        assert sum((lot["direction"] * lot["quantity"] for lot in books[instrument]),
                   Fraction(0)) == positions.get(instrument, Fraction(0))
    return {
        "realized": pair(realized),
        "lots": [{"opening_execution_id": lot["root"], "instrument_id": lot["instrument"],
                  "side": "LONG" if lot["direction"] == 1 else "SHORT",
                  "remaining_par": pair(lot["quantity"]),
                  "remaining_basis_or_proceeds_usd": pair(lot["amount"])} for lot in all_lots],
        "positions": [{"instrument_id": instrument, "signed_par": pair(positions[instrument])}
                      for instrument in IDS if instrument in positions],
    }


if __name__ == "__main__":
    raw = sys.stdin.buffer.read(1_048_577)
    if len(raw) > 1_048_576:
        raise ValueError("Input limit")
    books = json.loads(raw)
    if not isinstance(books, list) or not 1 <= len(books) <= 128:
        raise ValueError("Book-count limit")
    print(json.dumps([reconstruct(book) for book in books], separators=(",", ":")))
