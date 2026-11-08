"""A real matching callback cancels the old deadline while the controller runs."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
class MatchingTimerRuntime(unittest.TestCase):
    def test_java_matching_callback_cancels_old_deadline_across_live_timer_boundary(self):
        spec=importlib.util.spec_from_file_location('java_matching_timer_driver',ROOT/'tools/fix-session/runtime/driver.py')
        m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        with tempfile.TemporaryDirectory(dir='/state') as d,m.Lab(Path(d)) as lab:
            lab.start();mark=lab.mark();lab.send('java',{'35':'1','112':'SYN-J-GUARD-FIRST'})
            first=lab.wait('java','PROFILE_ACK',after=mark)
            self.assertEqual(first['fields']['112'],'SYN-J-GUARD-FIRST')
            for unused in range(8):lab.transport.hold_next('G_TO_J','0')
            ordinary=lab.transport.wait_held(0,timeout=40)
            self.assertNotIn('112',ordinary['fields'])
            next_request=lab.wait('java','PROFILE_REQUEST',after=mark,timeout=55,predicate=lambda e:e['fields'].get('112')=='TEST')
            response=lab.transport.wait_held(1,timeout=5)
            self.assertEqual(response['fields']['112'],'TEST')
            self.assertGreater(next_request['at']-first['at'],35)
            after=lab.mark();lab.transport.release_held(0);lab.transport.release_held(1)
            accepted=lab.wait('java','PROFILE_ACK',after=after)
            self.assertEqual(accepted['fields']['112'],'TEST')
            self.assertFalse(any(e['kind']=='PROFILE_TIMEOUT' for e in lab.events[mark:]))
            self.assertEqual(lab.count('java','LOGON'),1)

    def test_matching_callback_cancels_old_deadline_across_live_timer_boundary(self):
        spec=importlib.util.spec_from_file_location('matching_timer_driver',ROOT/'tools/fix-session/runtime/driver.py')
        m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        with tempfile.TemporaryDirectory(dir='/state') as d,m.Lab(Path(d)) as lab:
            lab.start();mark=lab.mark();lab.send('go',{'35':'1','112':'SYN-GUARD-FIRST'})
            first=lab.wait('go','PROFILE_ACK',after=mark)
            self.assertEqual(first['fields']['112'],'SYN-GUARD-FIRST')
            for unused in range(8):lab.transport.hold_next('J_TO_G','0')
            ordinary=lab.transport.wait_held(0,timeout=40)
            self.assertNotIn('112',ordinary['fields'])
            next_request=lab.wait('go','PROFILE_REQUEST',after=mark,timeout=45,predicate=lambda e:e['fields'].get('112')=='TEST')
            response=lab.transport.wait_held(1,timeout=5)
            self.assertEqual(response['fields']['112'],'TEST')
            self.assertGreater(next_request['at']-first['at'],35)
            after=lab.mark();lab.transport.release_held(0);lab.transport.release_held(1)
            accepted=lab.wait('go','PROFILE_ACK',after=after)
            self.assertEqual(accepted['fields']['112'],'TEST')
            self.assertFalse(any(e['kind']=='PROFILE_TIMEOUT' for e in lab.events[mark:]))
            self.assertEqual(lab.count('go','LOGON'),1)

if __name__=='__main__':unittest.main()
