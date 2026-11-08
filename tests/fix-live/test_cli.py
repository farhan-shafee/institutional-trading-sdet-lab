"""Real stdio bridge handshake; no financial SDK or database in the container."""
from datetime import datetime,timezone
import json
from pathlib import Path
import select
import subprocess
import sys
import unittest
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools/fix-session/runtime'))
from live_protocol import decode_line,encode_envelope

class StdioBridgeTests(unittest.TestCase):
    def test_ready_observation_callback_and_stop_are_distinct_bounded_envelopes(self):
        run,session,store,connection=[str(uuid4()) for unused in range(4)]
        process=subprocess.Popen([sys.executable,str(ROOT/'tools/fix-session/runtime/live_bridge.py'),'--root','/state/'+run,'--run-id',run,'--session-id',session,'--store-id',store,'--connection-id',connection,'--runtime-hash','a'*64],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        def cleanup():
            if process.poll() is None:
                process.terminate()
                try:process.wait(timeout=15)
                except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
            for stream in [process.stdin,process.stdout,process.stderr]:stream.close()
        self.addCleanup(cleanup)
        def read(timeout=5):
            self.assertTrue(select.select([process.stdout],[],[],timeout)[0],'bridge envelope deadline')
            raw=process.stdout.readline(24577)
            self.assertTrue(raw,'bridge exited before required envelope')
            return decode_line(raw)
        def send(kind,**fields):
            process.stdin.write(encode_envelope(kind,connection_id=connection,**fields));process.stdin.flush()
        ready=read(15);self.assertEqual(ready['kind'],'READY');self.assertEqual(ready['session_id'],session);self.assertEqual(ready['store_id'],store);self.assertGreater(int(ready['go_pid']),0);self.assertGreater(int(ready['java_pid']),0)
        send('ARM');self.assertEqual(read()['kind'],'ARMED')
        now=datetime.now(timezone.utc).strftime('%Y%m%d-%H:%M:%S.%f')[:-3]
        body={'35':'D','11':str(uuid4()),'21':'1','55':'SYN-UST-2031','167':'TNOTE','54':'1','60':now,'38':'100.00','40':'2','44':'100.050000000123','59':'1','15':'USD','64':'20280229','854':'0','423':'1'}
        send('SEND',role='java',command_id=str(uuid4()),fields=body)
        observed=read();self.assertEqual(observed['kind'],'OBSERVED');self.assertEqual(observed['connection_id'],connection)
        send('ACK',observation_id=observed['observation_id'],phase='OBSERVE')
        callback=read();self.assertEqual(callback['kind'],'CALLBACK');self.assertEqual(callback['observation_id'],observed['observation_id']);self.assertEqual(callback['callback_hex'],observed['raw_hex'])
        send('ACK',observation_id=observed['observation_id'],phase='ACCEPT');send('STOP')
        stopped=read(15);self.assertEqual(stopped['kind'],'STOPPED');self.assertEqual(stopped['pending'],0);self.assertEqual(stopped['financial_application_verified'],False)
        self.assertEqual(process.wait(timeout=5),0)

if __name__=='__main__':unittest.main()
