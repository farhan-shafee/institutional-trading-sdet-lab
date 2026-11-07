"""Real non-reading child and broken buffered pipe cleanup regressions."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]

class CleanupRuntime(unittest.TestCase):
    def test_full_stdin_after_scenario_alarm_still_reaps_child_and_emits_receipt(self):
        code=r'''
import importlib.util,json,os,signal,subprocess,sys,tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('cleanup_driver',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
    lab=m.Lab(Path(d));lab.__enter__()
    child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(45)'],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
    lab.children['go']=child;lab.lifetimes.append(('go',child))
    fd=child.stdin.fileno();os.set_blocking(fd,False)
    try:
        while True:os.write(fd,b'x'*4096)
    except BlockingIOError:pass
    finally:os.set_blocking(fd,True)
    def expired(*unused):raise TimeoutError('SCENARIO_DEADLINE')
    signal.signal(signal.SIGALRM,expired);signal.setitimer(signal.ITIMER_REAL,.01)
    try:signal.pause()
    except TimeoutError as error:lab.__exit__(type(error),error,error.__traceback__)
    assert child.poll() is not None
    assert lab.owner.lock is None
    assert lab.receipt['transport_evidence_complete'] is False
    assert 'SCENARIO_EXCEPTION' in lab.receipt['errors']
    assert 'OWNED_CHILD_FORCED_CLEANUP' in lab.receipt['errors']
    print('CLEANUP_CONTROL_OK',flush=True)
'''
        process=subprocess.Popen([sys.executable,'-c',code,str(ROOT/'tools/fix-session/runtime/driver.py')],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
        try:
            try:output=process.communicate(timeout=17)[0]
            except subprocess.TimeoutExpired:
                self.fail('cleanup blocked after the scenario alarm had already fired')
            self.assertEqual(process.returncode,0,output.decode())
            self.assertIn(b'LAB_RECEIPT\t',output);self.assertIn(b'CLEANUP_CONTROL_OK',output)
        finally:
            # Own probe group only, including a non-reading child on the RED run.
            try:os.killpg(process.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            process.communicate(timeout=3)

    def test_broken_buffered_stdin_close_cannot_suppress_receipt_or_unlock(self):
        spec=importlib.util.spec_from_file_location('broken_cleanup_driver',ROOT/'tools/fix-session/runtime/driver.py')
        m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        with tempfile.TemporaryDirectory() as d:
            lab=m.Lab(Path(d));lab.__enter__()
            child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
            lab.children['go']=child;lab.lifetimes.append(('go',child))
            child.stdin.write(b'buffered-but-not-flushed')
            child.kill();child.wait(timeout=3)
            try:lab.__exit__(TimeoutError,TimeoutError('SCENARIO_DEADLINE'),None)
            finally:
                if child.poll() is None:child.kill();child.wait(timeout=3)
                lab.owner.__exit__(None,None,None)
            self.assertIsNone(lab.owner.lock)
            self.assertFalse(lab.receipt['transport_evidence_complete'])
            self.assertIn('CHILD_STDIN_CLOSE',lab.receipt['errors'])

if __name__=='__main__':unittest.main()
