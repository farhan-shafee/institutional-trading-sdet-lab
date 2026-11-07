"""Run inside the locked, network-isolated runtime image."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[2]
def driver(test):
    path=ROOT/'tools/fix-session/runtime/driver.py'
    test.assertTrue(path.is_file(),'real local two-engine runtime is not implemented')
    spec=importlib.util.spec_from_file_location('runtime_driver',path)
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

class RuntimeTests(unittest.TestCase):
    def test_real_two_engine_logon_and_orderly_logout(self):
        m=driver(self)
        with tempfile.TemporaryDirectory(dir='/state') as d,m.Lab(Path(d)) as lab:
            lab.start()
            self.assertTrue(lab.established)
            self.assertEqual(lab.count('java','LOGON'),1)
            self.assertEqual(lab.count('go','LOGON'),1)
            self.assertEqual(lab.wait('java','VERSION')['fields']['engine'],'3.0.2')
            self.assertEqual(lab.wait('go','VERSION')['fields']['engine'],'v0.9.12')
            self.assertEqual(lab.wait('go','VERSION')['fields']['toolchain'],'go1.27.3')
            mark=lab.mark();lab.command('java','LOGOUT')
            lab.wait('java','LOGOUT',after=mark)
            lab.wait('go','LOGOUT',after=mark)
            self.assertEqual(lab.claims()['financial_application_verified'],False)
        self.assertTrue(lab.receipt['transport_evidence_complete'])
        self.assertFalse(lab.receipt['financial_application_verified'])
        self.assertEqual(lab.receipt['child_exit_codes'],{'go':0,'java':0})
        self.assertTrue(lab.receipt['wire'])
        self.assertTrue(lab.receipt['config_sha256']['java'])
        self.assertTrue(lab.receipt['store_inventory']['go'])
        self.assertIsInstance(lab.receipt['owned_state_bytes'],int)
        self.assertGreater(lab.receipt['owned_state_bytes'],sum(file['bytes'] for files in lab.receipt['store_inventory'].values() for file in files.values()))
        for process in lab.children.values():
            self.assertTrue(process.stdin.closed)
            self.assertTrue(process.stdout.closed)

    def test_exact_decimal_application_probes_both_directions(self):
        m=driver(self)
        with tempfile.TemporaryDirectory(dir='/state') as d,m.Lab(Path(d)) as lab:
            lab.start();order=str(uuid4());mark=lab.mark()
            lab.send('java',lab.order_probe(order))
            received=lab.wait('go','APP',after=mark)
            self.assertEqual(received['fields']['11'],order)
            self.assertEqual(received['fields']['44'],'100.050000000123')
            self.assertEqual(received['fields']['38'],'100.00')
            mark=lab.mark();lab.send('go',lab.ack_probe(order))
            received=lab.wait('java','APP',after=mark)
            self.assertEqual(received['fields']['44'],'100.050000000123')
            self.assertEqual(received['fields']['150'],'0')

    def test_cancel_and_cancel_reject_callbacks_remain_transport_only(self):
        m=driver(self)
        with tempfile.TemporaryDirectory(dir='/state') as d,m.Lab(Path(d)) as lab:
            lab.start();order=str(uuid4());cancel=str(uuid4());mark=lab.mark()
            lab.send('java',lab.cancel_probe(order,cancel))
            received=lab.wait('go','APP',after=mark)
            self.assertEqual(received['fields']['35'],'F')
            self.assertEqual(received['fields']['41'],order)
            self.assertEqual(received['fields']['11'],cancel)
            mark=lab.mark();lab.send('go',lab.cancel_reject_probe(order,cancel))
            received=lab.wait('java','APP',after=mark)
            self.assertEqual(received['fields']['35'],'9')
            self.assertEqual(received['fields']['41'],order)
            self.assertEqual(received['fields']['11'],cancel)
            self.assertFalse(lab.claims()['financial_application_verified'])

    def test_acceptor_can_initiate_orderly_logout(self):
        m=driver(self)
        with tempfile.TemporaryDirectory(dir='/state') as d,m.Lab(Path(d)) as lab:
            lab.start();mark=lab.mark();lab.command('go','LOGOUT')
            lab.wait('java','LOGOUT',after=mark)
            lab.wait('go','LOGOUT',after=mark)

if __name__=='__main__':unittest.main()
