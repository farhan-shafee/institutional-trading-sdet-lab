"""Bridge protocol controls only; these do not claim engine or financial proof."""
import json
import os
from pathlib import Path
import socket
import sys
import time
import unittest
import tempfile
from uuid import uuid4
from types import SimpleNamespace

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools/fix-session/runtime'))
from live_protocol import BridgeError,LaneGate,OutputChannel,decode_line,encode_envelope
from live_bridge import LiveTransport,LiveRuntime,MAX_RUNTIME_BYTES
from wire import encode_fault_frame

PROFILE='live-fix-ingress-v1'

class BridgeProtocolTests(unittest.TestCase):
    def test_control_envelopes_share_the_actual_owned_runtime_budget_at_the_exact_boundary(self):
        with tempfile.TemporaryDirectory() as temporary:
            run,session,store,connection=[str(uuid4()) for unused in range(4)];events=[]
            lab=LiveRuntime(Path(temporary)/run,run,session,store,connection,'a'*64,events.append)
            with lab.owner:
                event={'version':1,'profile':PROFILE,'kind':'ARMED','session_id':session,'store_id':store,'connection_id':connection}
                size=len(encode_envelope('ARMED',session_id=session,store_id=store,connection_id=connection))
                remaining=MAX_RUNTIME_BYTES-lab.owner.budget()-size
                path=lab.root/'budget.dat'
                with path.open('xb') as file:file.truncate(remaining+1)
                with self.assertRaisesRegex(BridgeError,'LIVE_AGGREGATE_BUDGET'):lab.emit(event)
                self.assertEqual(events,[])
                with path.open('r+b') as file:file.truncate(remaining)
                lab.emit(event);self.assertEqual(events,[event]);self.assertEqual(lab.bridge_bytes+lab.owner.budget(),MAX_RUNTIME_BYTES)

    def frame(self):
        rows=json.loads((ROOT/'test-data/fix44/live/manifest.json').read_text())
        return bytes.fromhex(next(row['raw_hex'] for row in rows if row['accepted'] and row['fields']['35']=='D'))

    def test_literal_versioned_envelope_and_strict_line_bounds(self):
        line=encode_envelope('STOP')
        self.assertEqual(json.loads(line),{'version':1,'profile':PROFILE,'kind':'STOP'})
        self.assertEqual(decode_line(line),json.loads(line))
        for raw in [b'{"version":1,"version":2}\n',b'{"version":NaN}\n',b'[]\n',b'{}',b'x'*24577+b'\n',b'{"version":2,"profile":"live-fix-ingress-v1","kind":"STOP"}\n']:
            with self.subTest(raw=raw[:40]),self.assertRaises(BridgeError):decode_line(raw)
        with self.assertRaises(BridgeError):encode_envelope('OBSERVED',raw_hex='a'*24576)

    def test_original_bytes_wait_for_observation_ack_and_separate_callback_ack(self):
        events=[];clock=[0.0];gate=LaneGate(events.append,lambda:clock[0]);raw=self.frame()
        source,target=socket.socketpair();self.addCleanup(source.close);self.addCleanup(target.close);target.setblocking(False)
        observed=gate.offer('J_TO_G',raw,source.sendall)
        self.assertEqual(events[0]['kind'],'OBSERVED');self.assertEqual(bytes.fromhex(events[0]['raw_hex']),raw)
        with self.assertRaises(BlockingIOError):target.recv(8192)
        gate.ack(observed,'OBSERVE');self.assertEqual(target.recv(8192),raw)
        gate.callback('go',raw,1)
        self.assertEqual(events[-1]['kind'],'CALLBACK');self.assertEqual(events[-1]['observation_id'],observed)
        self.assertEqual(gate.pending,1);gate.ack(observed,'ACCEPT');self.assertEqual(gate.pending,0)

    def test_a_later_application_frame_cannot_overtake_the_held_frame(self):
        events=[];forwarded=[];gate=LaneGate(events.append);raw=self.frame()
        first=gate.offer('J_TO_G',raw,forwarded.append);second=gate.offer('J_TO_G',raw,forwarded.append)
        self.assertEqual(len(events),1);self.assertEqual(forwarded,[])
        gate.ack(first,'OBSERVE');gate.callback('go',raw,1)
        self.assertEqual(len(events),2);gate.ack(first,'ACCEPT')
        self.assertEqual(events[-1]['observation_id'],second);self.assertEqual(len(forwarded),1)
        gate.ack(second,'OBSERVE');self.assertEqual(forwarded,[raw,raw])

    def test_admin_cannot_overtake_a_held_application_on_the_actual_selected_transport(self):
        events=[];gate=LaneGate(events.append);lab=SimpleNamespace(armed=True,gate=gate)
        transport=LiveTransport(lab);transport.record=lambda *unused:None
        source,target=socket.socketpair();self.addCleanup(source.close);self.addCleanup(target.close);target.setblocking(False)
        raw=self.frame();heartbeat=encode_fault_frame({'35':'0','49':'TRADEFLOW','56':'ATLAS','34':'3','52':'20261107-12:00:00.000'})
        transport.forward('J_TO_G',raw,source)
        transport.forward('J_TO_G',heartbeat,source)
        with self.assertRaises(BlockingIOError):target.recv(8192)
        self.assertEqual(gate.pending,2)

    def test_admin_and_app_share_the_same_fifo_and_sixteen_frame_bound(self):
        events=[];sent=[];gate=LaneGate(events.append);raw=self.frame()
        heartbeat=encode_fault_frame({'35':'0','49':'TRADEFLOW','56':'ATLAS','34':'3','52':'20261107-12:00:00.000'})
        first=gate.offer('J_TO_G',raw,sent.append)
        gate.offer_admin('J_TO_G',heartbeat,sent.append)
        later=gate.offer('J_TO_G',raw,sent.append)
        self.assertEqual(sent,[]);gate.ack(first,'OBSERVE');gate.callback('go',raw,1);gate.ack(first,'ACCEPT')
        self.assertEqual(sent,[raw,heartbeat]);self.assertEqual(gate.pending,2)
        self.assertEqual(len(events),2,'later application must wait for the physical admin write')
        gate.forwarded_admin('J_TO_G',heartbeat)
        self.assertEqual(events[-1]['observation_id'],later)
        gate=LaneGate(lambda event:None);gate.offer('J_TO_G',raw,sent.append)
        for unused in range(15):gate.offer_admin('J_TO_G',heartbeat,sent.append)
        self.assertEqual(gate.pending,16)
        with self.assertRaises(BridgeError):gate.offer_admin('J_TO_G',heartbeat,sent.append)

    def test_application_replay_waits_for_registration_without_blocking_prior_logon(self):
        events=[];sent=[];gate=LaneGate(events.append);gate.suspend()
        heartbeat=encode_fault_frame({'35':'0','49':'TRADEFLOW','56':'ATLAS','34':'3','52':'20261107-12:00:00.000'})
        gate.offer_admin('J_TO_G',heartbeat,sent.append);gate.forwarded_admin('J_TO_G',heartbeat)
        observation=gate.offer('J_TO_G',self.frame(),sent.append)
        self.assertEqual(events,[]);self.assertEqual(sent,[heartbeat])
        gate.resume();self.assertEqual(events[0]['observation_id'],observation)
        self.assertEqual(sent,[heartbeat]);gate.ack(observation,'OBSERVE');self.assertEqual(sent,[heartbeat,self.frame()])

    def test_connection_role_and_callback_mismatch_fail_closed(self):
        events=[];gate=LaneGate(events.append);raw=self.frame();observed=gate.offer('J_TO_G',raw,lambda value:None)
        gate.ack(observed,'OBSERVE')
        with self.assertRaises(BridgeError):gate.callback('java',raw,1)
        self.assertEqual(gate.pending,1);self.assertEqual(len(events),1)
        with self.assertRaises(BridgeError):gate.ack(observed,'ACCEPT')

    def test_changed_callback_fields_cannot_witness_the_original_wire(self):
        events=[];gate=LaneGate(events.append);raw=self.frame();observed=gate.offer('J_TO_G',raw,lambda value:None)
        gate.ack(observed,'OBSERVE')
        with self.assertRaises(BridgeError):gate.callback('go',raw.replace(b'ATLAS',b'BIRCH'),1)
        self.assertEqual(len(events),1)

    def test_the_seventeenth_queued_application_and_unknown_ack_are_rejected(self):
        gate=LaneGate(lambda event:None);raw=self.frame()
        for unused in range(16):gate.offer('J_TO_G',raw,lambda value:None)
        self.assertEqual(gate.pending,16)
        with self.assertRaises(BridgeError):gate.offer('J_TO_G',raw,lambda value:None)
        with self.assertRaises(BridgeError):gate.ack(str(uuid4()),'OBSERVE')

    def test_expired_ack_keeps_the_original_attempt_unresolved(self):
        clock=[0.0];gate=LaneGate(lambda event:None,lambda:clock[0]);observed=gate.offer('J_TO_G',self.frame(),lambda value:None)
        clock[0]=5.001
        with self.assertRaises(BridgeError):gate.expire()
        self.assertEqual(gate.pending,1)
        with self.assertRaises(BridgeError):gate.ack(observed,'OBSERVE')

    def test_full_output_pipe_does_not_block_enqueue_or_shutdown(self):
        read_fd,write_fd=os.pipe();self.addCleanup(os.close,read_fd);self.addCleanup(os.close,write_fd);os.set_blocking(write_fd,False)
        while True:
            try:os.write(write_fd,b'x'*4096)
            except BlockingIOError:break
        channel=OutputChannel(write_fd);self.addCleanup(channel.close)
        started=time.monotonic();channel.emit({'version':1,'profile':PROFILE,'kind':'STOPPED'})
        self.assertLess(time.monotonic()-started,.25)
        channel.close();self.assertFalse(channel.alive)

    def test_output_flush_reports_only_bytes_actually_written_to_the_owned_pipe(self):
        read_fd,write_fd=os.pipe();self.addCleanup(os.close,read_fd);self.addCleanup(os.close,write_fd)
        channel=OutputChannel(write_fd);self.addCleanup(channel.close)
        event={'version':1,'profile':PROFILE,'kind':'STOPPED'};channel.emit(event);channel.flush()
        self.assertEqual(decode_line(os.read(read_fd,24576)),event)

if __name__=='__main__':unittest.main()
