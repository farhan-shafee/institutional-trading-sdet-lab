"""Physical duplicates traverse the real engine; no sequence files are edited."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
def driver():
    spec=importlib.util.spec_from_file_location('duplicate_driver',ROOT/'tools/fix-session/runtime/driver.py')
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

class DuplicateRuntimeTests(unittest.TestCase):
    def test_low_sequence_without_possdup_logs_out_without_new_callback(self):
        m=driver()
        with tempfile.TemporaryDirectory(dir='/state') as d,m.Lab(Path(d)) as lab:
            lab.start();lab.transport.duplicate_next('J_TO_G','D',possdup=False)
            mark=lab.mark();lab.send('java',lab.order_probe('SYN-PHYSICAL-DUP'))
            lab.wait('go','APP',after=mark);lab.wait('go','LOGOUT',after=mark)
            frames=lab.transport.wait_frames(lambda f:f['stage']=='forwarded_bytes' and f['fields'].get('11')=='SYN-PHYSICAL-DUP',count=2)
            self.assertEqual(len(frames),2);self.assertEqual(frames[0]['raw_hex'],frames[1]['raw_hex'])
            self.assertEqual(lab.count('go','APP'),1)
            logout=lab.transport.wait_frames(lambda f:f['fields']['35']=='5' and f['direction']=='G_TO_J')
            self.assertEqual(logout[0]['fields']['35'],'5')

    def test_duplicate_possdup_replay_is_not_new_logical_work(self):
        m=driver()
        with tempfile.TemporaryDirectory(dir='/state') as d,m.Lab(Path(d)) as lab:
            lab.start();lab.transport.drop_next('J_TO_G','D')
            lab.transport.duplicate_next('J_TO_G','D',possdup=True)
            lab.send('java',lab.order_probe('SYN-REPLAY-DUP'))
            lab.send('java',lab.order_probe('SYN-AFTER-DUP'))
            lab.wait('go','APP',predicate=lambda e:e['fields'].get('11')=='SYN-AFTER-DUP')
            apps=[e['fields']['11'] for e in lab.events if e['role']=='go' and e['kind']=='APP']
            self.assertEqual(apps,['SYN-REPLAY-DUP','SYN-AFTER-DUP'])
            replay=lab.transport.wait_frames(lambda f:f['stage']=='forwarded_bytes' and f['fields'].get('11')=='SYN-REPLAY-DUP',count=2)
            self.assertEqual(len(replay),2);self.assertEqual(replay[0]['raw_hex'],replay[1]['raw_hex'])
            self.assertEqual(replay[0]['fields']['43'],'Y')

if __name__=='__main__':unittest.main()
