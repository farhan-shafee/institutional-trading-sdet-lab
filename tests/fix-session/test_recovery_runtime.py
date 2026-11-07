"""Actual owned process kills at declared persisted-state barriers."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
def driver():
    spec=importlib.util.spec_from_file_location('recovery_driver',ROOT/'tools/fix-session/runtime/driver.py')
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

class RecoveryRuntimeTests(unittest.TestCase):
    def test_killed_initiator_replays_persisted_unreceived_order(self):
        m=driver()
        with tempfile.TemporaryDirectory(dir='/state') as d,m.Lab(Path(d)) as lab:
            lab.start();identity=lab.identity;lab.transport.hold_next('J_TO_G','D')
            lab.send('java',lab.order_probe('SYN-CRASH-SEND'))
            original=lab.transport.wait_held(0)
            self.assertEqual(original['fields']['34'],'2')
            self.assertEqual(lab.count('go','APP'),0)
            barrier=lab.checkpoint_kill('java',sender_min=3,target_min=2)
            self.assertEqual(barrier['exit_code'],-9)
            self.assertEqual(barrier['barrier'],'persisted-counter-and-file-snapshot')
            mark=lab.mark();lab.restart('java')
            recovered=lab.wait('go','APP',after=mark,predicate=lambda e:e['fields'].get('11')=='SYN-CRASH-SEND')
            self.assertEqual(recovered['fields']['43'],'Y')
            self.assertEqual(recovered['fields']['122'],original['fields']['52'])
            self.assertEqual(recovered['fields']['44'],'100.050000000123')
            self.assertEqual(lab.identity,identity)
            self.assertEqual(lab.count('go','APP'),1)
            self.assertTrue(lab.restarts[-1]['store_verified_before_spawn'])
            lab.prove_restart('java')
        self.assertTrue(lab.receipt['session_continuity_verified'])

    def test_killed_acceptor_retains_receive_sequence_without_new_logical_work(self):
        m=driver()
        with tempfile.TemporaryDirectory(dir='/state') as d,m.Lab(Path(d)) as lab:
            lab.start();mark=lab.mark();lab.send('java',lab.order_probe('SYN-CRASH-RECEIVE'))
            lab.wait('go','APP',after=mark)
            lab.pause('java')
            barrier=lab.checkpoint_kill('go',sender_min=2,target_min=3)
            self.assertEqual(barrier['exit_code'],-9)
            mark=lab.mark();lab.restart('go');lab.resume('java')
            lab.wait('java','LOGON',after=mark);lab.wait('go','LOGON',after=mark)
            self.assertEqual(lab.count('go','APP'),1)
            mark=lab.mark();lab.send('java',lab.order_probe('SYN-AFTER-RESTART'))
            next_order=lab.wait('go','APP',after=mark)
            self.assertEqual(next_order['fields']['11'],'SYN-AFTER-RESTART')
            self.assertEqual(next_order['fields']['34'],'4')
            self.assertTrue(lab.restarts[-1]['store_verified_before_spawn'])
            lab.prove_restart('go')
        self.assertTrue(lab.receipt['session_continuity_verified'])

    def test_changed_checkpoint_bytes_are_not_replaced_on_restart(self):
        m=driver()
        with tempfile.TemporaryDirectory(dir='/state') as d:
            with self.assertRaisesRegex(ValueError,'^STORE_CHANGED_OR_UNCERTAIN$'):
                with m.Lab(Path(d)) as lab:
                    lab.start();lab.checkpoint_kill('java',sender_min=2,target_min=2)
                    body=next((Path(d)/'java').glob('*.body'));before=body.read_bytes()
                    body.write_bytes(before+b'CORRUPTION_CONTROL')
                    lab.restart('java')
            self.assertEqual(body.read_bytes(),before+b'CORRUPTION_CONTROL')
            self.assertFalse(lab.receipt['transport_evidence_complete'])
            self.assertIn('SCENARIO_EXCEPTION',lab.receipt['errors'])

if __name__=='__main__':unittest.main()
