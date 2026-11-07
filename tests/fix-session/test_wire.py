"""Literal wire and resource controls, independent of either engine."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
HEARTBEAT = b"8=FIX.4.4\x019=57\x0135=0\x0149=TRADEFLOW\x0156=ATLAS\x0134=2\x0152=20261107-14:00:00.000\x0110=222\x01"

def load_wire(test):
    path = ROOT / "tools/fix-session/runtime/wire.py"
    test.assertTrue(path.is_file(), "bounded runtime wire admission is not implemented")
    spec = importlib.util.spec_from_file_location("runtime_wire", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

class WireTests(unittest.TestCase):
    def test_literal_heartbeat(self):
        m = load_wire(self)
        fields = m.decode_frame(HEARTBEAT)
        self.assertEqual(fields["35"], "0")
        self.assertEqual(fields["34"], "2")
        self.assertEqual(fields["49"], "TRADEFLOW")

    def test_fragmentation_and_coalescing(self):
        m = load_wire(self)
        f = m.Framer()
        self.assertEqual(f.feed(HEARTBEAT[:7]), [])
        self.assertEqual(f.feed(HEARTBEAT[7:] + HEARTBEAT), [HEARTBEAT, HEARTBEAT])
        f.finish()

    def test_checksum_and_bodylength_corruption(self):
        m = load_wire(self)
        for wire in [HEARTBEAT.replace(b"10=222", b"10=223"), HEARTBEAT.replace(b"9=57", b"9=56"), HEARTBEAT[:-1]]:
            with self.subTest(wire=wire), self.assertRaises(m.WireError):
                m.decode_frame(wire)

    def test_no_resynchronization_after_corruption(self):
        m = load_wire(self)
        f = m.Framer()
        with self.assertRaises(m.WireError):
            f.feed(b"garbage" + HEARTBEAT)
        with self.assertRaises(m.WireError):
            f.feed(HEARTBEAT)

    def test_eof_rejects_unfinished_frame(self):
        m = load_wire(self)
        f = m.Framer()
        self.assertEqual(f.feed(HEARTBEAT[:-5]), [])
        with self.assertRaises(m.WireError): f.finish()

    def test_empty_input_is_not_a_message(self):
        m = load_wire(self)
        self.assertEqual(m.Framer().feed(b""), [])
        with self.assertRaises(m.WireError): m.decode_frame(b"")

    def test_symbolic_soh_and_non_ascii_refused(self):
        m = load_wire(self)
        for data in [HEARTBEAT.replace(b"\x01", b"|"), HEARTBEAT.replace(b"ATLAS", b"ATLA\xff"), HEARTBEAT+b"\n"]:
            with self.subTest(data=data),self.assertRaises(m.WireError): m.decode_frame(data)

    def test_actual_raw_value_is_preserved(self):
        m = load_wire(self)
        fields = {"35":"D","49":"TRADEFLOW","56":"ATLAS","34":"2","52":"20261107-14:00:00.000","11":"11111111-1111-4111-8111-111111111111","44":"100.050000000123","38":"100.00"}
        wire = m.encode_fault_frame(fields)
        self.assertEqual(m.decode_frame(wire)["44"],"100.050000000123")
        self.assertEqual(m.decode_frame(wire)["38"],"100.00")

    def test_non_string_and_reserved_builder_fields_refused(self):
        m = load_wire(self)
        valid = {"35":"0","49":"TRADEFLOW","56":"ATLAS","34":"2","52":"20261107-14:00:00.000"}
        for fields in [dict(valid, **{"10":"222"}), dict(valid, **{"44":100.05}),dict(valid, **{"112":"x"*257})]:
            with self.subTest(fields=fields),self.assertRaises(m.WireError):m.encode_fault_frame(fields)

    def test_frame_and_buffer_budgets(self):
        m = load_wire(self)
        for data in [b"x"*8193, b"8=FIX.4.4\x019=99999\x01", b"x"*16385]:
            with self.subTest(size=len(data)),self.assertRaises(m.WireError):m.Framer().feed(data)

    def test_batch_backpressure_does_not_drop_seventeenth_frame(self):
        m = load_wire(self)
        f = m.Framer()
        self.assertEqual(f.feed(HEARTBEAT*17),[HEARTBEAT]*16)
        with self.assertRaises(m.WireError): f.feed(HEARTBEAT)
        g=m.Framer()
        self.assertEqual(g.feed(HEARTBEAT*17),[HEARTBEAT]*16)
        self.assertEqual(g.feed(b""),[HEARTBEAT])
        g.finish()

    def test_duplicate_fields_are_never_overwritten(self):
        m=load_wire(self)
        body=b"35=0\x0149=TRADEFLOW\x0156=ATLAS\x0134=2\x0152=20261107-14:00:00.000\x01112=A\x01112=B\x01"
        prefix=b"8=FIX.4.4\x019="+str(len(body)).encode()+b"\x01"+body
        raw=prefix+b"10="+f"{sum(prefix)%256:03d}".encode()+b"\x01"
        with self.assertRaises(m.WireError):m.decode_frame(raw)

if __name__ == "__main__":unittest.main()
