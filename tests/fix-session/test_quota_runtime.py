"""Exhausted owned evidence budget denies SEND before engine-store mutation."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
class QuotaRuntimeTests(unittest.TestCase):
    def test_exhausted_budget_denies_send_without_deleting_evidence(self):
        spec=importlib.util.spec_from_file_location('quota_driver',ROOT/'tools/fix-session/runtime/driver.py')
        m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        with tempfile.TemporaryDirectory(dir='/state') as d:
            with self.assertRaisesRegex(ValueError,'^STORE_BUDGET$'):
                with m.Lab(Path(d)) as lab:
                    lab.start();lab.state('java',2,2)
                    body=next((Path(d)/'java').glob('*.body'));before=body.read_bytes()
                    control=Path(d)/'quota-control';amount=67108864-lab.owner.budget()+1
                    with control.open('wb') as out:out.truncate(amount)
                    try:lab.send('java',lab.order_probe('SYN-QUOTA-DENIED'))
                    except ValueError:
                        self.assertEqual(body.read_bytes(),before)
                        self.assertEqual(lab.count('go','APP'),0)
                        raise
            self.assertEqual(control.stat().st_size,amount)
            self.assertEqual(lab.count('go','APP'),0)
            self.assertFalse(lab.receipt['transport_evidence_complete'])

if __name__=='__main__':unittest.main()
