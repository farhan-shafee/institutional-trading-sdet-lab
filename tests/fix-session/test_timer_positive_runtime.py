"""Paired control for the pinned-peer heartbeat mismatch reproduction."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
class TimerPositiveRuntimeTests(unittest.TestCase):
    def test_go_times_out_when_no_heartbeat_is_released(self):
        spec=importlib.util.spec_from_file_location('timer_positive_driver',ROOT/'tools/fix-session/runtime/driver.py')
        m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        with tempfile.TemporaryDirectory(dir='/state') as d,m.Lab(Path(d)) as lab:
            lab.start();mark=lab.mark()
            for unused in range(8):lab.transport.hold_next('J_TO_G','0')
            ordinary=lab.transport.wait_held(0,timeout=40)
            self.assertNotIn('112',ordinary['fields'])
            request=lab.wait('go','ADMIN_OUT',after=mark,timeout=45,predicate=lambda e:e['fields'].get('35')=='1')
            self.assertEqual(request['fields']['112'],'TEST')
            response=lab.transport.wait_held(1,timeout=5)
            self.assertEqual(response['fields']['112'],'TEST')
            closed=lab.wait('go','LOGOUT',after=mark,timeout=40)
            self.assertGreaterEqual(closed['at']-request['at'],35)
            self.assertLess(closed['at']-request['at'],40)

if __name__=='__main__':unittest.main()
