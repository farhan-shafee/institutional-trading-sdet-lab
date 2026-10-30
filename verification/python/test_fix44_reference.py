"""Protocol oracle and dictionary negative controls; no TypeScript imports."""
import hashlib
import json
from pathlib import Path
import unittest
from fix44_reference import parse_wire, reference_frame, check_profile, Dictionary44, ProtocolError

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = json.loads((ROOT / 'test-data/fix44/manifest.json').read_text())

def fixture(name):
    return next(f for f in FIXTURES if f['name'] == name)

class FixReferenceTests(unittest.TestCase):
    def test_independent_literal_byte_example(self):
        # Independently hand-counted 35=D<SOH> is five bytes; prefix sum modulo256=183.
        self.assertEqual(reference_frame([('35','D')]), b'8=FIX.4.4\x019=5\x0135=D\x0110=183\x01')

    def test_all_golden_bytes_and_pinned_dictionary(self):
        dictionary = Dictionary44()
        for f in FIXTURES:
            with self.subTest(f=f['name']):
                wire = (ROOT / 'test-data/fix44' / f['file']).read_bytes()
                parsed = parse_wire(wire)
                dictionary.validate(parsed)
                check_profile(parsed)
                self.assertEqual(hashlib.sha256(wire).hexdigest(), f['sha256'])
                self.assertEqual(parsed[9], str(f['body_length']))
                self.assertEqual(parsed[10], f['checksum'])
                for tag, value in f['fields'].items():
                    self.assertEqual(parsed[int(tag)],value)

    def test_framing_faults_are_independently_rejected(self):
        good = reference_frame([('35','D')])
        for bad in [good[:-1], good.replace(b'9=5',b'9=6'), good.replace(b'183',b'000'),good.replace(b'\x01',b'|'), good+b'x', b'8=FIX.4.4\x019=1\x01\xff']:
            with self.subTest():
                with self.assertRaises(ProtocolError): parse_wire(bad)
        with self.assertRaises(ProtocolError): parse_wire(reference_frame([('35','D'),('35','D')]))

    def test_dictionary_negative_controls(self):
        dictionary = Dictionary44()
        f = {int(k):v for k,v in fixture('partial')['fields'].items()}
        f.update({8:'FIX.4.4',9:'1',10:'000'})
        for changes in [{6:None},{150:'1'},{150:'2'},{54:'Z'},{39:'Z'},{9999:'x'},{38:'not-a-number'},{60:'20260229-12:00:00.000'}]:
            with self.subTest(changes=changes):
                altered={k:v for k,v in (f | changes).items() if v is not None}
                with self.assertRaises(ProtocolError): dictionary.validate(altered)
        for name, tag in [('new-buy-ust',37),('cancel-reject',17)]:
            altered={int(k):v for k,v in fixture(name)['fields'].items()} | {8:'FIX.4.4',9:'1',10:'000',tag:'FAKE'}
            with self.assertRaises(ProtocolError): dictionary.validate(altered)

    def test_review_shortened_dates_are_not_FIX_dates(self):
        d=Dictionary44()
        f={int(k):v for k,v in fixture('new-buy-ust')['fields'].items()} | {8:'FIX.4.4',9:'1',10:'000'}
        for value in ['2026111','202611','20260229','20261301']:
            with self.subTest(value=value):
                with self.assertRaises(ProtocolError): d.validate(f | {64:value})
                with self.assertRaises(ProtocolError): check_profile(f | {64:value})

    def test_standard_and_bilateral_requirements_are_distinct(self):
        dictionary = Dictionary44()
        # Dictionary permits no Price on a LIMIT; its cross-field condition is prose.
        # Our independent bilateral checker rejects it. Dictionary success alone is insufficient.
        f={int(k):v for k,v in fixture('new-buy-ust')['fields'].items()} | {8:'FIX.4.4',9:'1',10:'000'}
        del f[44]
        dictionary.validate(f)
        with self.assertRaises(ProtocolError): check_profile(f)

    def test_exact_financial_and_trade_semantic_negative_controls(self):
        f={int(k):v for k,v in fixture('partial')['fields'].items()}
        for changes in [{44:'99.1'},{38:'100000'},{150:'1'},{31:'99.123456789013'},{32:'40000.01'},{151:'60000.01'},{39:'2'},{14:'100000.01'},{41:'invented'}]:
            with self.subTest(changes=changes):
                with self.assertRaises(ProtocolError): check_profile(f | changes)

if __name__ == '__main__': unittest.main()
