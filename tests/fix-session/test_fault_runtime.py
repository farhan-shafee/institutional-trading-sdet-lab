"""Declared faults over real engines; upstream stores are never edited."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
def driver():
    spec=importlib.util.spec_from_file_location('fault_driver',ROOT/'tools/fix-session/runtime/driver.py')
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

class FaultRuntimeTests(unittest.TestCase):
    def test_both_testrequest_ids_are_echoed_by_matching_heartbeat(self):
        m=driver()
        with tempfile.TemporaryDirectory(dir='/state') as d,m.Lab(Path(d)) as lab:
            lab.start()
            for role,identifier in [('java','SYN-J-REQUEST'),('go','SYN-G-REQUEST')]:
                mark=lab.mark();lab.send(role,{'35':'1','112':identifier})
                response=lab.wait(role,'ADMIN_IN',after=mark,predicate=lambda e:e['fields'].get('35')=='0' and e['fields'].get('112')==identifier)
                self.assertEqual(response['fields']['112'],identifier)

    def test_disconnect_reconnect_keeps_sequences_and_original_identity(self):
        m=driver()
        with tempfile.TemporaryDirectory(dir='/state') as d,m.Lab(Path(d)) as lab:
            lab.start();identity=lab.identity;mark=lab.mark();lab.transport.disconnect()
            lab.wait('java','LOGON',after=mark);lab.wait('go','LOGON',after=mark)
            self.assertEqual(lab.identity,identity)
            logons=[f for f in lab.transport.frames if f['stage']=='sender_observed' and f['fields']['35']=='A']
            self.assertEqual([f['fields']['34'] for f in logons],['1','1','2','2'])

    def test_dropped_order_is_replayed_before_later_order_callback(self):
        m=driver()
        with tempfile.TemporaryDirectory(dir='/state') as d,m.Lab(Path(d)) as lab:
            lab.start();mark=lab.mark();lab.transport.drop_next('J_TO_G','D')
            lab.send('java',lab.order_probe('SYN-ORDER-1'))
            lab.send('java',lab.order_probe('SYN-ORDER-2'))
            lab.wait('go','APP',after=mark,predicate=lambda e:e['fields'].get('11')=='SYN-ORDER-2')
            applications=[e['fields'] for e in lab.events[mark:] if e['role']=='go' and e['kind']=='APP']
            self.assertEqual([e['11'] for e in applications],['SYN-ORDER-1','SYN-ORDER-2'])
            self.assertEqual(applications[0]['43'],'Y')
            original=next(f['fields'] for f in lab.transport.frames if f['stage']=='sender_observed' and f['fields'].get('11')=='SYN-ORDER-1' and '43' not in f['fields'])
            self.assertEqual(applications[0]['122'],original['52'])
            self.assertEqual(applications[0]['44'],'100.050000000123')
            self.assertTrue(any(e['fields'].get('35')=='2' for e in lab.events[mark:]))

    def test_dropped_ack_retains_execid_and_exact_business_body_on_replay(self):
        m=driver()
        with tempfile.TemporaryDirectory(dir='/state') as d,m.Lab(Path(d)) as lab:
            lab.start();mark=lab.mark();lab.transport.drop_next('G_TO_J','8')
            first=lab.ack_probe('SYN-ORDER-1');first['17']='ATLAS-ACK-1'
            second=lab.ack_probe('SYN-ORDER-2');second['17']='ATLAS-ACK-2'
            lab.send('go',first);lab.send('go',second)
            lab.wait('java','APP',after=mark,predicate=lambda e:e['fields'].get('17')=='ATLAS-ACK-2')
            apps=[e['fields'] for e in lab.events[mark:] if e['role']=='java' and e['kind']=='APP']
            self.assertEqual([e['17'] for e in apps],['ATLAS-ACK-1','ATLAS-ACK-2'])
            self.assertEqual(apps[0]['43'],'Y')
            frames=[f['fields'] for f in lab.transport.frames if f['stage']=='sender_observed' and f['fields'].get('17')=='ATLAS-ACK-1']
            self.assertEqual(len(frames),2)
            excluded={'8','9','10','34','43','52','122'}
            self.assertEqual({k:v for k,v in frames[0].items() if k not in excluded},{k:v for k,v in frames[1].items() if k not in excluded})
            self.assertEqual(frames[1]['122'],frames[0]['52'])

    def test_admin_gapfill_does_not_skip_the_retained_application(self):
        m=driver()
        with tempfile.TemporaryDirectory(dir='/state') as d,m.Lab(Path(d)) as lab:
            lab.start();mark=lab.mark();lab.transport.drop_next('J_TO_G','0')
            lab.send('java',{'35':'0'});lab.send('java',lab.order_probe('SYN-GAP-ORDER'))
            received=lab.wait('go','APP',after=mark)
            self.assertEqual(received['fields']['11'],'SYN-GAP-ORDER')
            gap=next(e['fields'] for e in lab.events[mark:] if e['fields'].get('35')=='4')
            self.assertEqual((gap['34'],gap['36'],gap['123']),('2','3','Y'))
            self.assertEqual(received['fields']['34'],'3')

if __name__=='__main__':unittest.main()
