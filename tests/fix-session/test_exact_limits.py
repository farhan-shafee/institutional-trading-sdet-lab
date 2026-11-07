"""Literal exact-limit and one-over controls, independently built FIX fixtures."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[2]
def module(name):
    spec=importlib.util.spec_from_file_location('limits_'+name,ROOT/('tools/fix-session/runtime/'+name+'.py'))
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

BASE=b'35=0\x0149=TRADEFLOW\x0156=ATLAS\x0134=2\x0152=20261107-14:00:00.000\x01'
def literal(extra):
    body=BASE+extra;prefix=b'8=FIX.4.4\x019='+str(len(body)).encode()+b'\x01'+body
    return prefix+b'10='+f'{sum(prefix)%256:03d}'.encode()+b'\x01'

class ExactLimitTests(unittest.TestCase):
    def test_exact_frame_and_buffer_boundary_and_one_over(self):
        m=module('wire')
        padding=b''.join(str(5000+i).encode()+b'='+b'x'*256+b'\x01' for i in range(30))
        exact=literal(padding+b'5030='+b'x'*245+b'\x01')
        self.assertEqual(len(exact),8192);m.decode_frame(exact)
        self.assertEqual(m.Framer().feed(exact*2),[exact,exact])
        for raw in [literal(padding+b'5030='+b'x'*246+b'\x01'),exact*2+b'x']:
            with self.assertRaises(m.WireError):m.Framer().feed(raw)

    def test_exact_field_and_value_boundary_and_one_over(self):
        m=module('wire')
        fields=b''.join(str(5000+i).encode()+b'=x\x01' for i in range(56))
        self.assertEqual(len(m.decode_frame(literal(fields))),64)
        with self.assertRaisesRegex(m.WireError,'^FIELD_LIMIT$'):m.decode_frame(literal(fields+b'5056=x\x01'))
        self.assertEqual(len(m.decode_frame(literal(b'112='+b'x'*256+b'\x01'))['112']),256)
        with self.assertRaisesRegex(m.WireError,'^FIELD_VALUE$'):m.decode_frame(literal(b'112='+b'x'*257+b'\x01'))

    def test_exact_store_limit_and_one_over_retain_every_byte(self):
        m=module('ownership')
        with tempfile.TemporaryDirectory() as d,m.StoreOwner(Path(d),str(uuid4())) as owner:
            path=Path(d)/'unacknowledged-evidence'
            current=owner.budget();remaining=67108864-current
            with path.open('wb') as out:out.truncate(remaining)
            self.assertEqual(owner.budget(),67108864)
            with path.open('r+b') as out:out.truncate(remaining+1)
            with self.assertRaisesRegex(m.OwnershipError,'^STORE_BUDGET$'):owner.budget()
            self.assertEqual(path.stat().st_size,remaining+1)

if __name__=='__main__':unittest.main()
