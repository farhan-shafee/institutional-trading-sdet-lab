"""Real selected engine byte/callback proof only; no SQL or financial claims."""
from datetime import datetime,timezone
from pathlib import Path
import json
import queue
import sys
import unittest
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools/fix-session/runtime'))
from live_bridge import LiveRuntime
from wire import decode_frame

class SelectedEngineTests(unittest.TestCase):
    def test_unreceived_persisted_order_is_retransmitted_by_the_actual_restarted_engine(self):
        events=queue.Queue();run=str(uuid4());runtime=LiveRuntime(Path('/state')/run,run,str(uuid4()),str(uuid4()),str(uuid4()),'a'*64,events.put_nowait)
        self.addCleanup(lambda:print('LIVE_ENGINE_RECEIPT\t'+json.dumps(runtime.receipt,sort_keys=True),flush=True) if hasattr(runtime,'receipt') else None)
        with runtime as lab:
            lab.start();lab.arm(lab.connection_id)
            lab.transport.drop_next('J_TO_G','D');lab.send('java',lab.order_probe(str(uuid4())))
            original=lab.transport.wait_frames(lambda f:f['direction']=='J_TO_G' and f['stage']=='sender_observed' and f['fields']['35']=='D')[0]
            lab.state('java',3,2)
            connection=lab.reconnect('java');lab.arm(connection['connection_id'])
            observed=events.get(timeout=5);self.assertEqual(observed['kind'],'OBSERVED')
            raw=bytes.fromhex(observed['raw_hex']);fields=decode_frame(raw)
            self.assertEqual(fields['43'],'Y');self.assertEqual(fields['34'],original['fields']['34']);self.assertEqual(fields['122'],original['fields']['52'])
            omitted={'8','9','10','43','52','122'}
            self.assertEqual({k:v for k,v in fields.items() if k not in omitted},{k:v for k,v in original['fields'].items() if k not in omitted})
            lab.gate.ack(observed['observation_id'],'OBSERVE')
            callback=events.get(timeout=5);self.assertEqual(callback['kind'],'CALLBACK');self.assertEqual(callback['role'],'go');self.assertEqual(callback['callback_hex'],observed['raw_hex'])
            lab.gate.ack(observed['observation_id'],'ACCEPT')
        self.assertTrue(lab.receipt['transport_evidence_complete']);self.assertTrue(lab.receipt['session_continuity_verified']);self.assertFalse(lab.receipt['financial_application_verified'])

    def test_real_D_8_F_9_callbacks_preserve_original_bytes_and_all_required_fields(self):
        events=queue.Queue();run=str(uuid4());order=str(uuid4());cancel=str(uuid4())
        runtime=LiveRuntime(Path('/state')/run,run,str(uuid4()),str(uuid4()),str(uuid4()),'a'*64,events.put_nowait)
        self.addCleanup(lambda:print('LIVE_ENGINE_RECEIPT\t'+json.dumps(runtime.receipt,sort_keys=True),flush=True) if hasattr(runtime,'receipt') else None)
        with runtime as lab:
            lab.start();lab.arm(lab.connection_id)
            now=lambda:datetime.now(timezone.utc).strftime('%Y%m%d-%H:%M:%S.%f')[:-3]
            order_fields={'35':'D','11':order,'21':'1','55':'SYN-UST-2031','167':'TNOTE','54':'1','60':now(),'38':'100.00','40':'2','44':'100.050000000123','59':'1','15':'USD','64':'20280229','854':'0','423':'1'}
            report={**order_fields,'35':'8','37':'ATLAS-'+order.upper(),'17':'ATLAS-'+str(uuid4()).upper(),'150':'0','39':'0','14':'0.00','151':'100.00','6':'0.000000000000'};del report['21']
            cancel_fields={'35':'F','11':cancel,'41':order,'37':'ATLAS-'+order.upper(),'55':'SYN-UST-2031','167':'TNOTE','54':'1','60':now(),'38':'100.00'}
            reject={'35':'9','11':cancel,'41':order,'37':'ATLAS-'+order.upper(),'39':'0','434':'1','102':'99','60':now()}
            for role,body,receiver in [('java',order_fields,'go'),('go',report,'java'),('java',cancel_fields,'go'),('go',reject,'java')]:
                lab.send(role,body)
                observed=events.get(timeout=5);self.assertEqual(observed['kind'],'OBSERVED')
                self.assertEqual(lab.count(receiver,'LIVE_APP'),0 if body['35'] in ('D','8') else 1)
                raw=bytes.fromhex(observed['raw_hex']);fields=decode_frame(raw)
                for tag,value in body.items():self.assertEqual(fields[tag],value)
                lab.gate.ack(observed['observation_id'],'OBSERVE')
                callback=events.get(timeout=5);self.assertEqual(callback['kind'],'CALLBACK');self.assertEqual(callback['role'],receiver)
                self.assertEqual(bytes.fromhex(callback['callback_hex']),raw)
                lab.gate.ack(observed['observation_id'],'ACCEPT');self.assertEqual(lab.gate.pending,0)
        self.assertEqual(lab.receipt['financial_application_verified'],False)
        self.assertEqual(lab.receipt['transport_evidence_complete'],True)

if __name__=='__main__':unittest.main()
