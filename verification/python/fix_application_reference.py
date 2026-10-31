"""Independent actual-wire/dictionary/ledger oracle; no TypeScript imports or SQL helper calls."""
import base64
import json
import sys
from fractions import Fraction
from fix44_reference import Dictionary44, parse_wire, check_profile
from execution_reference import execution_cents


def verify(document):
    contract = document['order']['contract']
    order_id = document['order']['id']
    assert contract['financial_source'] == '6016fb700840d081fe1fba651c918f0a7e709383'
    assert contract['valuation_model_version'] == 'phase1-regular-coupon-v1'
    assert contract['instrument_revision'] in ('phase1-ust-1', 'phase1-corp-1')
    dictionary = Dictionary44()
    seen = set()
    fills = {}
    par = Fraction(0)
    cash = 0
    for message in document['messages']:
        fields = parse_wire(base64.b64decode(message['raw_base64'], validate=True))
        dictionary.validate(fields)
        check_profile(fields)
        assert fields[11] == order_id or fields.get(41) == order_id
        if fields[35] in ('D', '8'):
            assert fields[44] == contract['clean_price']
            assert fields[38] == contract['par_amount']
            assert fields[55] == contract['instrument_id']
            assert fields[54] == ('1' if contract['side'] == 'BUY' else '2')
            assert fields[64] == contract['settlement_date'].replace('-', '')
        if fields[35] == '8':
            identity = (fields[49], fields[17])
            assert identity not in seen
            seen.add(identity)
        if fields.get(150) == 'F':
            par += Fraction(fields[32])
            assert Fraction(fields[14]) == par
            expected = execution_cents(fields[31], fields[32], contract['instrument_revision'], contract['settlement_date'])
            cash += expected
            fills[message['execution_id']] = (message['source_event_id'], Fraction(fields[32]), expected)
    assert len(fills) == len(document['executions'])
    for fill in document['executions']:
        assert fills[fill['id']] == (fill['source_event_id'], Fraction(fill['par_amount']), int(fill['consideration_cents']))
        assert fill['order_id'] == order_id
        assert fill['clean_price'] == contract['clean_price']
        assert fill['settlement_date'] == contract['settlement_date']
        assert fill['instrument_revision'] == contract['instrument_revision']
    sign = 1 if contract['side'] == 'BUY' else -1
    position = document['position']
    assert Fraction(position['signed_par']) == sign * par
    assert int(position['signed_cash_cents']) == -sign * cash
    assert position['execution_count'] == len(fills)
    assert Fraction(document['lifecycle']['filled_par']) == par
    assert int(document['lifecycle']['executed_cents']) == cash
    whole = execution_cents(contract['clean_price'], str(par), contract['instrument_revision'], contract['settlement_date'])
    return {'frames': len(document['messages']), 'executions': len(fills), 'cash_cents': cash, 'per_fill_minus_whole_cents': cash-whole}


if __name__ == '__main__':
    raw = sys.stdin.buffer.read(1048577)
    assert len(raw) <= 1048576
    print(json.dumps(verify(json.loads(raw))))
