"""Reproducing controls for the blocked-checkpoint independent review."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
HEARTBEAT=b'8=FIX.4.4\x019=57\x0135=0\x0149=TRADEFLOW\x0156=ATLAS\x0134=2\x0152=20261107-14:00:00.000\x0110=222\x01'
def driver():
    spec=importlib.util.spec_from_file_location('review_driver',ROOT/'tools/fix-session/runtime/driver.py')
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

class ReviewControls(unittest.TestCase):
    def test_an_unstarted_run_cannot_emit_a_complete_success_receipt(self):
        m=driver()
        with tempfile.TemporaryDirectory() as d,contextlib.redirect_stdout(io.StringIO()):
            lab=m.Lab(Path(d))
            with self.assertRaisesRegex(m.LabError,'^RUNTIME_NOT_ESTABLISHED$'):
                with lab:pass
            self.assertFalse(lab.receipt['transport_evidence_complete'])

    def test_concurrent_records_are_persisted_once_in_observation_order(self):
        m=driver()
        with tempfile.TemporaryDirectory() as d:
            lab=m.Lab(Path(d));transport=lab.transport;original=Path.open
            first_open=threading.Event();release=threading.Event();second_done=threading.Event();failures=[]
            def opening(path,*args,**kwargs):
                handle=original(path,*args,**kwargs)
                if path==Path(d)/'wire.jsonl' and threading.current_thread().name=='first-recorder':
                    first_open.set()
                    if not release.wait(3):raise AssertionError('controlled first-writer barrier expired')
                return handle
            def record(stage,done=None):
                try:transport.record('J_TO_G',stage,HEARTBEAT)
                except BaseException as error:failures.append(error)
                finally:
                    if done:done.set()
            with patch.object(Path,'open',opening):
                first=threading.Thread(target=record,args=('sender_observed',),name='first-recorder')
                second=threading.Thread(target=record,args=('forwarded_bytes',second_done))
                first.start();self.assertTrue(first_open.wait(3));second.start()
                # A serialized writer blocks the second call until the first releases.
                second_done.wait(1);release.set();first.join(3);second.join(3)
            self.assertFalse(first.is_alive() or second.is_alive());self.assertEqual(failures,[])
            persisted=[json.loads(line)['stage'] for line in (Path(d)/'wire.jsonl').read_text().splitlines()]
            self.assertEqual(persisted,['sender_observed','forwarded_bytes'])
            self.assertEqual([frame['stage'] for frame in transport.frames],persisted)

    def read_child(self,script):
        m=driver()
        with tempfile.TemporaryDirectory() as d:
            lab=m.Lab(Path(d));lab.closing=True
            child=subprocess.Popen([sys.executable,'-c',script],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
            try:lab._reader('go',child)
            finally:
                child.stdout.close()
                try:child.wait(timeout=5)
                except subprocess.TimeoutExpired:child.kill();child.wait(timeout=5)
            return lab

    def test_valid_child_events_have_a_total_count_limit(self):
        lab=self.read_child("import sys;sys.stdout.write('EVENT\\tREADY\\t\\n'*1025)")
        self.assertEqual(len(lab.events),1024)
        self.assertIn('CHILD_EVENT_BUDGET',lab.errors)

    def test_ignored_child_output_still_consumes_a_total_byte_budget(self):
        lab=self.read_child("import sys;sys.stdout.write(('x'*1023+'\\n')*4097)")
        self.assertIn('CHILD_OUTPUT_BUDGET',lab.errors)
        self.assertEqual(lab.events,[])

if __name__=='__main__':unittest.main()
