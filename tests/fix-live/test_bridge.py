"""Bridge protocol controls only; these do not claim engine or financial proof."""
import json
import os
from pathlib import Path
import socket
import sys
import time
import unittest
import tempfile
import threading
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

    def transport_case(self,temporary):
        run,session,store,connection=[str(uuid4()) for unused in range(4)]
        return LiveRuntime(Path(temporary)/run,run,session,store,connection,'a'*64,lambda event:None)

    def write_pending(self,transport):
        worker=threading.Thread(target=transport._write,args=('J_TO_G',),daemon=True);worker.start()
        try:transport.drain()
        finally:transport.writer_stop.set();worker.join(timeout=1)
        self.assertFalse(worker.is_alive())

    def test_reconnect_retirement_retains_interrupted_admin_without_writing_the_closed_socket(self):
        with tempfile.TemporaryDirectory() as temporary:
            lab=self.transport_case(temporary)
            source,target=socket.socketpair()
            with source,target,lab.owner:
                transport=lab.transport;transport.sockets=[source,target]
                transport.quiesce_connection()
                heartbeat=encode_fault_frame({'35':'0','49':'TRADEFLOW','56':'ATLAS','34':'3','52':'20261107-12:00:00.000'})
                transport.forward('J_TO_G',heartbeat,source);source.close()
                self.write_pending(transport)
                self.assertEqual(lab.errors,[]);self.assertEqual(lab.gate.pending,0)
                self.assertEqual([(f['stage'],f['raw_hex']) for f in transport.frames],[('interrupted_admin_bytes',heartbeat.hex())])

    def test_unplanned_closed_socket_write_remains_unresolved(self):
        with tempfile.TemporaryDirectory() as temporary:
            lab=self.transport_case(temporary)
            source,target=socket.socketpair()
            with source,target,lab.owner:
                transport=lab.transport
                heartbeat=encode_fault_frame({'35':'0','49':'TRADEFLOW','56':'ATLAS','34':'3','52':'20261107-12:00:00.000'})
                transport.forward('J_TO_G',heartbeat,source);source.close()
                self.write_pending(transport)
                self.assertEqual(len(lab.errors),1);self.assertTrue(lab.errors[0].startswith('LIVE_FORWARD_'))
                self.assertEqual(lab.gate.pending,1);self.assertEqual(transport.frames,[])

    def test_retired_socket_cannot_rebind_application_bytes_to_the_next_connection(self):
        with tempfile.TemporaryDirectory() as temporary:
            lab=self.transport_case(temporary)
            source,target=socket.socketpair()
            with source,target,lab.owner:
                transport=lab.transport;transport.sockets=[source,target]
                transport.quiesce_connection()
                from driver import LabError
                with self.assertRaisesRegex(LabError,'LIVE_RETIRED_APPLICATION_UNRESOLVED'):
                    transport.forward('J_TO_G',self.frame(),source)
                self.assertEqual(lab.gate.pending,0);self.assertEqual(transport.frames,[])

    def test_only_an_explicitly_retired_owned_socket_can_complete_a_reset_as_disconnect(self):
        with tempfile.TemporaryDirectory() as temporary:
            lab=self.transport_case(temporary)
            source,target=socket.socketpair();foreign,peer=socket.socketpair()
            with source,target,foreign,peer,lab.owner:
                transport=lab.transport;transport.sockets=[source,target]
                transport.quiesce_connection();source.close();foreign.close()
                self.assertEqual(transport.receive(source,8192),b'')
                self.assertEqual(len(transport.retired_receive_errors),1)
                with self.assertRaises(OSError):transport.receive(foreign,8192)
                self.assertEqual(len(transport.retired_receive_errors),1)


    def heartbeat(self):
        return encode_fault_frame({'35':'0','49':'TRADEFLOW','56':'ATLAS','34':'3','52':'20261107-12:00:00.000'})

    def test_normal_close_retires_the_selected_pair_before_child_stop_can_emit_late_admin(self):
        from unittest.mock import patch
        from driver import Lab
        with tempfile.TemporaryDirectory() as temporary:
            lab=self.transport_case(temporary);transport=lab.transport
            source,target=socket.socketpair()
            with source,target,lab.owner:
                transport.sockets=[source,target];lab.gate.resume();lab.armed=True
                def stop_children(unused_lab,kind,value,trace):
                    self.assertFalse(lab.armed)
                    self.assertFalse(lab.gate.active)
                    transport.forward('J_TO_G',self.heartbeat(),source);source.close()
                    self.write_pending(transport);transport.close()
                with patch.object(Lab,'_close',stop_children):lab._close(None,None,None)
                self.assertEqual(lab.errors,[]);self.assertEqual(lab.gate.pending,0)
                self.assertEqual([f['stage'] for f in transport.frames],['interrupted_admin_bytes'])

    def test_shutdown_drains_admin_enqueued_by_the_last_producer_after_network_stop(self):
        with tempfile.TemporaryDirectory() as temporary:
            lab=self.transport_case(temporary);transport=lab.transport;failures=[]
            source,target=socket.socketpair()
            with source,target,lab.owner:
                transport.sockets=[source,target]
                def last_batch():
                    try:
                        if not transport.stop.wait(1):raise AssertionError('network stop missing')
                        transport.forward('J_TO_G',self.heartbeat(),source);source.close()
                        worker=threading.Thread(target=transport._write,args=('J_TO_G',),daemon=True)
                        transport.writers.append(worker);worker.start()
                    except BaseException as error:failures.append(repr(error))
                producer=threading.Thread(target=last_batch,daemon=True);transport.thread=producer;producer.start()
                transport.close()
                self.assertFalse(producer.is_alive());self.assertEqual(failures,[])
                self.assertEqual(transport.writes['J_TO_G'].unfinished_tasks,0)
                self.assertEqual(lab.gate.pending,0);self.assertEqual(lab.errors,[])
                self.assertEqual([f['stage'] for f in transport.frames],['interrupted_admin_bytes'])

    def test_a_foreign_closed_target_still_fails_after_network_stop(self):
        with tempfile.TemporaryDirectory() as temporary:
            lab=self.transport_case(temporary);transport=lab.transport
            source,target=socket.socketpair()
            with source,target,lab.owner:
                transport.forward('J_TO_G',self.heartbeat(),source);source.close();transport.stop.set()
                worker=threading.Thread(target=transport._write,args=('J_TO_G',),daemon=True);worker.start()
                try:
                    worker.join(timeout=.1)
                    self.assertTrue(any(code.startswith('LIVE_FORWARD_') for code in lab.errors))
                    self.assertEqual(transport.frames,[]);self.assertEqual(lab.gate.pending,1)
                finally:
                    getattr(transport,'writer_stop',transport.stop).set();worker.join(timeout=1)
                self.assertFalse(worker.is_alive())

    def test_final_shutdown_cannot_report_clean_with_an_application_still_held(self):
        with tempfile.TemporaryDirectory() as temporary:
            lab=self.transport_case(temporary)
            with lab.owner:
                lab.gate.offer('J_TO_G',self.frame(),lambda raw:None)
                lab.transport.close()
                self.assertIn('LIVE_APPLICATION_UNRESOLVED',lab.errors)
                self.assertEqual(lab.gate.pending_application,1)

    def test_opposite_partial_frame_is_retained_as_failure_on_eof_and_producer_stop(self):
        from unittest.mock import patch
        for stopped in (False,True):
            with self.subTest(stopped=stopped),tempfile.TemporaryDirectory() as temporary:
                lab=self.transport_case(temporary);transport=lab.transport
                left,left_peer=socket.socketpair();right,right_peer=socket.socketpair()
                with left,left_peer,right,right_peer,lab.owner:
                    class Listener:
                        accepted=False
                        def accept(inner):
                            if not inner.accepted:inner.accepted=True;return left,('local',0)
                            transport.stop.set();raise socket.timeout()
                    transport.listener=Listener();right_peer.sendall(self.heartbeat()[:12]);left_peer.shutdown(socket.SHUT_WR)
                    calls=[0]
                    def ready(*unused):
                        calls[0]+=1
                        if calls[0]==1:return [right],[],[]
                        if stopped:transport.stop.set();return [],[],[]
                        return [left],[],[]
                    with patch('driver.socket.create_connection',return_value=right),patch('driver.select.select',side_effect=ready):transport.run()
                    self.assertIn('TRANSPORT_TRUNCATED',lab.errors)
                    self.assertEqual(transport.frames,[])

    def test_shutdown_retires_a_concurrently_installed_owned_pair_without_authorizing_foreign_sockets(self):
        with tempfile.TemporaryDirectory() as temporary:
            lab=self.transport_case(temporary);transport=lab.transport
            source,target=socket.socketpair();foreign,peer=socket.socketpair()
            with source,target,foreign,peer,lab.owner:
                transport.begin_shutdown()
                transport.connection_opened((source,target))
                self.assertTrue(transport.retired(source));self.assertTrue(transport.retired(target))
                self.assertFalse(transport.retired(foreign))
                source.close();foreign.close()
                self.assertEqual(transport.receive(source,8192),b'')
                with self.assertRaises(OSError):transport.receive(foreign,8192)

    def test_failed_gate_and_partial_startup_still_complete_shutdown_without_resetting_failure(self):
        for channel_count in (0,1):
            with self.subTest(channel_count=channel_count),tempfile.TemporaryDirectory() as temporary:
                lab=self.transport_case(temporary);transport=lab.transport
                source,target=socket.socketpair()
                with source,target,lab.owner:
                    transport.sockets=[source][:channel_count];lab.gate.failed=True;lab.armed=True
                    transport.close()
                    self.assertTrue(lab.gate.failed);self.assertFalse(lab.gate.active);self.assertFalse(lab.armed)
                    self.assertIn('LIVE_LANE_FAILED',lab.errors)
                    self.assertEqual([q.unfinished_tasks for q in transport.writes.values()],[0,0])

    def test_a_producer_surviving_its_existing_join_bound_prevents_clean_shutdown(self):
        with tempfile.TemporaryDirectory() as temporary:
            lab=self.transport_case(temporary);bounds=[]
            class Producer:
                def join(self,timeout):bounds.append(timeout)
                def is_alive(self):return True
            with lab.owner:
                lab.transport.thread=Producer();lab.transport.close()
                self.assertEqual(bounds,[4])
                self.assertIn('TRANSPORT_SHUTDOWN',lab.errors)


    def test_shutdown_cannot_retroactively_retire_a_pair_that_closed_unplanned(self):
        from wire import Framer
        with tempfile.TemporaryDirectory() as temporary:
            lab=self.transport_case(temporary);transport=lab.transport
            source,target=socket.socketpair()
            with source,target,lab.owner:
                transport.sockets=[source,target];transport.connection_opened((source,target))
                transport.connection_closing((source,target),{source:Framer(),target:Framer()})
                source.close();target.close()
                # The producer has not cleared its public snapshot yet.
                transport.begin_shutdown()
                transport.forward('J_TO_G',self.heartbeat(),source);self.write_pending(transport)
                self.assertFalse(transport.retired(source))
                self.assertTrue(any(code.startswith('LIVE_FORWARD_') for code in lab.errors))
                self.assertEqual(transport.frames,[]);self.assertEqual(lab.gate.pending,1)

    def test_last_producer_application_or_protocol_error_survives_network_stop_before_lane_admission(self):
        from unittest.mock import patch
        for malformed in (False,True):
            with self.subTest(malformed=malformed),tempfile.TemporaryDirectory() as temporary:
                lab=self.transport_case(temporary);transport=lab.transport
                left,left_peer=socket.socketpair();right,right_peer=socket.socketpair()
                with left,left_peer,right,right_peer,lab.owner:
                    class Listener:
                        def accept(inner):return left,('local',0)
                    transport.listener=Listener()
                    raw=self.frame()
                    if malformed:raw=raw[:-4]+b'999'+raw[-1:]
                    left_peer.sendall(raw)
                    def last_batch(*unused):
                        transport.begin_shutdown();transport.stop.set();return [left],[],[]
                    with patch('driver.socket.create_connection',return_value=right),patch('driver.select.select',side_effect=last_batch):transport.run()
                    expected='TRANSPORT_CHECKSUM' if malformed else 'TRANSPORT_LIVE_RETIRED_APPLICATION_UNRESOLVED'
                    self.assertIn(expected,lab.errors)
                    self.assertEqual(lab.gate.pending,0)
                    self.assertFalse(any(f['stage']=='forwarded_bytes' for f in transport.frames))

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
