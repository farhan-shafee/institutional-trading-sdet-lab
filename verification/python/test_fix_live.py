"""Literal verdicts exercise the independent live wire oracle, never TypeScript."""
import hashlib,json
from pathlib import Path
import unittest
from fix_live import parse_live_wire,ProtocolError
ROOT=Path(__file__).resolve().parents[2]
class LiveWireTests(unittest.TestCase):
    def test_literal_corpus(self):
        rows=json.loads((ROOT/'test-data/fix44/live/manifest.json').read_text())
        self.assertEqual(len(rows),20)
        for row in rows:
            with self.subTest(name=row['name']):
                raw=bytes.fromhex(row['raw_hex'])
                self.assertEqual(hashlib.sha256(raw).hexdigest(),row['sha256'])
                if row['accepted']:
                    self.assertEqual({str(k):v for k,v in parse_live_wire(raw).items()},row['fields'])
                else:
                    with self.assertRaises(ProtocolError):parse_live_wire(raw)
    def test_checksum_and_frame_budget_are_enforced(self):
        with self.assertRaises(ProtocolError):parse_live_wire(b'x'*8193)
        first=json.loads((ROOT/'test-data/fix44/live/manifest.json').read_text())[0]
        raw=bytearray.fromhex(first['raw_hex']);raw[-2]=48 if raw[-2]!=48 else 49
        with self.assertRaises(ProtocolError):parse_live_wire(bytes(raw))
if __name__=='__main__':unittest.main()
