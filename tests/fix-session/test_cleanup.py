"""A real unresponsive owned child cannot be a success or stop another child."""
import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

ROOT=Path(__file__).resolve().parents[2]
class CleanupTests(unittest.TestCase):
    def test_forced_cleanup_is_bounded_failed_and_limited_to_owned_process(self):
        spec=importlib.util.spec_from_file_location('cleanup_driver',ROOT/'tools/fix-session/runtime/driver.py')
        m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        script="import sys,threading;print('started',flush=True);threading.Event().wait(45)"
        unrelated=subprocess.Popen([sys.executable,'-c',script],stdout=subprocess.PIPE)
        try:
            self.assertEqual(unrelated.stdout.readline(),b'started\n')
            with tempfile.TemporaryDirectory() as d,contextlib.redirect_stdout(io.StringIO()):
                lab=m.Lab(Path(d));started=time.monotonic()
                with self.assertRaises(m.LabError):
                    with lab:
                        owned=subprocess.Popen([sys.executable,'-c',script],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
                        self.assertEqual(owned.stdout.readline(),b'started\n')
                        lab.children['go']=owned;lab.lifetimes.append(('go',owned))
                self.assertLess(time.monotonic()-started,17)
                self.assertEqual(owned.returncode,-9)
                self.assertIn('OWNED_CHILD_FORCED_CLEANUP',lab.receipt['errors'])
                self.assertIn('CONFIG_FINAL_INVENTORY',lab.receipt['errors'])
                self.assertFalse(lab.receipt['transport_evidence_complete'])
                self.assertIsNone(lab.owner.lock)
                self.assertIsNone(unrelated.poll())
        finally:
            unrelated.kill();unrelated.wait(timeout=5);unrelated.stdout.close()

if __name__=='__main__':unittest.main()
