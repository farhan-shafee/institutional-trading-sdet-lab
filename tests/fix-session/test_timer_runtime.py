"""Real elapsed-time TestRequest control; no engine clock or store edits."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
def driver():
    spec=importlib.util.spec_from_file_location('timer_driver',ROOT/'tools/fix-session/runtime/driver.py')
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

class TimerRuntimeTests(unittest.TestCase):
    def test_ordinary_heartbeat_cannot_answer_outstanding_go_testrequest(self):
        m=driver()
        with tempfile.TemporaryDirectory(dir='/state') as d,m.Lab(Path(d)) as lab:
            lab.start();mark=lab.mark()
            # Hold exact original bytes in order. No gap or sequence rewrite is introduced.
            for unused in range(8):lab.transport.hold_next('J_TO_G','0')
            ordinary=lab.transport.wait_held(0,timeout=40)
            self.assertNotIn('112',ordinary['fields'])
            request=lab.wait('go','ADMIN_OUT',after=mark,timeout=45,predicate=lambda e:e['fields'].get('35')=='1')
            self.assertEqual(request['fields']['112'],'TEST')
            response=lab.transport.wait_held(1,timeout=5)
            self.assertEqual(response['fields']['112'],'TEST')
            self.assertEqual((ordinary['fields']['34'],response['fields']['34']),('2','3'))
            after_request=lab.mark();lab.transport.release_held(0)
            accepted=lab.wait('go','ADMIN_IN',after=after_request,predicate=lambda e:e['fields'].get('35')=='0')
            self.assertNotIn('112',accepted['fields'])
            self.assertFalse(any(f['direction']=='J_TO_G' and f['stage']=='forwarded_bytes' and f['fields'].get('112')=='TEST' for f in lab.transport.frames))
            # The engine's pinned peer timeout is 1.2 * HeartBtInt = 36 seconds.
            # A nonmatching heartbeat must not cancel the outstanding request.
            lab.wait('go','LOGOUT',after=after_request,timeout=40)

if __name__=='__main__':unittest.main()
