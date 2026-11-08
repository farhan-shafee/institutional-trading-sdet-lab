"""The same required matching-ID property in the initiator direction."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
class JavaTimerRuntime(unittest.TestCase):
    def test_ordinary_heartbeat_cannot_answer_outstanding_java_testrequest(self):
        spec=importlib.util.spec_from_file_location('java_timer_driver',ROOT/'tools/fix-session/runtime/driver.py')
        m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        with tempfile.TemporaryDirectory(dir='/state') as d,m.Lab(Path(d)) as lab:
            lab.start();mark=lab.mark()
            for unused in range(8):lab.transport.hold_next('G_TO_J','0')
            ordinary=lab.transport.wait_held(0,timeout=40)
            self.assertNotIn('112',ordinary['fields'])
            request=lab.wait('java','ADMIN_OUT',after=mark,timeout=55,predicate=lambda e:e['fields'].get('35')=='1')
            self.assertEqual(request['fields']['112'],'TEST')
            response=lab.transport.wait_held(1,timeout=5)
            self.assertEqual(response['fields']['112'],'TEST')
            self.assertEqual((ordinary['fields']['34'],response['fields']['34']),('2','3'))
            after=lab.mark();lab.transport.release_held(0)
            observed=lab.wait('java','ADMIN_IN',after=after,predicate=lambda e:e['fields'].get('35')=='0')
            self.assertNotIn('112',observed['fields'])
            self.assertFalse(any(f['direction']=='G_TO_J' and f['stage']=='forwarded_bytes' and f['fields'].get('112')=='TEST' for f in lab.transport.frames))
            lab.wait('java','LOGOUT',after=after,timeout=40)

if __name__=='__main__':unittest.main()
