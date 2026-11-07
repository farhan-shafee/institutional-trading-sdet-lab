"""Opt-in engine bridge. No database credential, financial command or socket listener outside the container."""
import hashlib
import argparse
import json
import os
from pathlib import Path
import queue
import re
import select
import signal
import sys
import threading
import time
from uuid import UUID,uuid4

from driver import Lab,LabError,FaultTransport,BODY_FIELDS
from live_protocol import BridgeError,LaneGate,OutputChannel,PROFILE,MAX_BYTES,MAX_ENVELOPE,decode_line,encode_envelope
from ownership import _read_json
from wire import decode_frame

MAX_RUNTIME_BYTES=MAX_BYTES//2

class LiveTransport(FaultTransport):
    def __init__(self,lab):
        super().__init__(lab)
        self.body_fields={**BODY_FIELDS,'D':BODY_FIELDS['D']+' 75','8':BODY_FIELDS['8']+' 59 41 103 75','F':BODY_FIELDS['F']+' 37 167 58','9':BODY_FIELDS['9']+' 60'}
        self.writes={direction:queue.Queue(1) for direction in ('J_TO_G','G_TO_J')}
        self.writers=[]

    def record(self,direction,stage,raw):
        fields=super().record(direction,stage,raw)
        try:self.lab.check_budget()
        except BridgeError as error:raise LabError(str(error)) from None
        return fields

    def start(self):
        for direction in self.writes:
            worker=threading.Thread(target=self._write,args=(direction,),daemon=True)
            self.writers.append(worker);worker.start()
        super().start()

    def forward(self,direction,raw,target):
        application=decode_frame(raw)['35'] in ('D','8','F','9')
        def schedule(original):
            try:self.writes[direction].put_nowait((original,target))
            except queue.Full:raise BridgeError('FORWARD_QUEUE_FULL') from None
        try:
            if application:self.lab.gate.offer(direction,raw,schedule)
            else:self.lab.gate.offer_admin(direction,raw,schedule)
        except BridgeError as error:raise LabError('LIVE_'+str(error)) from None

    def _write(self,direction):
        while not self.stop.is_set():
            try:raw,target=self.writes[direction].get(timeout=.05)
            except queue.Empty:continue
            try:
                super().forward(direction,raw,target)
                if decode_frame(raw)['35'] not in ('D','8','F','9'):self.lab.gate.forwarded_admin(direction,raw)
            except (OSError,ValueError,LabError):
                if not self.stop.is_set():self.lab.fail('LIVE_FORWARD_IO')
            finally:self.writes[direction].task_done()

    def close(self):
        super().close()
        for worker in self.writers:
            worker.join(timeout=1)
            if worker.is_alive():self.lab.fail('LIVE_WRITER_SHUTDOWN')

    def drain(self):
        # Finish already scheduled wire writes before STOP can close either peer.
        # The existing socket write timeout is two seconds; no SQL hold is released.
        deadline=time.monotonic()+2
        for writes in self.writes.values():
            with writes.all_tasks_done:
                while writes.unfinished_tasks:
                    remaining=deadline-time.monotonic()
                    if remaining<=0:raise BridgeError('LIVE_FORWARD_DRAIN_DEADLINE')
                    writes.all_tasks_done.wait(min(remaining,.05))

class LiveRuntime(Lab):
    def __init__(self,root,run_id,session_id,store_id,connection_id,runtime_hash,publish):
        identities=[run_id,session_id,store_id,connection_id]
        try:
            if any(str(UUID(value))!=value for value in identities) or len(set(identities))!=4:raise ValueError()
        except (ValueError,TypeError,AttributeError):raise BridgeError('LIVE_IDENTITY') from None
        if not isinstance(runtime_hash,str) or not re.fullmatch('[a-f0-9]{64}',runtime_hash):raise BridgeError('LIVE_RUNTIME_HASH')
        super().__init__(root,run_id)
        self.session_id=session_id;self.store_id=store_id;self.connection_id=connection_id;self.runtime_hash=runtime_hash
        self.publish=publish;self.bridge_bytes=0;self.publish_lock=threading.Lock();self.callback_ordinals={'go':0,'java':0};self.armed=False
        self.gate=LaneGate(self._publish);self.gate.suspend();self.transport=LiveTransport(self)
        self.reconnecting=False;self.connection_count=1;self.connection_ids={connection_id}

    def __enter__(self):
        super().__enter__()
        try:
            metadata={'version':1,'profile':PROFILE,'run_id':self.identity,'session_id':self.session_id,'store_id':self.store_id,'runtime_hash':self.runtime_hash}
            path=self.root/'.live-profile.json'
            if path.exists():
                if _read_json(path)!=metadata:raise BridgeError('LIVE_STORE_IDENTITY')
            else:
                if self.owner.reopened:raise BridgeError('LIVE_STORE_IDENTITY_MISSING')
                with path.open('x',encoding='ascii') as out:
                    json.dump(metadata,out,sort_keys=True,separators=(',',':'));out.flush();os.fsync(out.fileno())
            self.store_hash=hashlib.sha256(path.read_bytes()).hexdigest()
            return self
        except BaseException:
            self.owner.__exit__(None,None,None);raise

    def _config(self,role):
        path=super()._config(role)
        with path.open('a',encoding='ascii') as out:out.write('TradeFlowIngressProfile='+PROFILE+'\n')
        return path

    def arm(self,connection_id):
        if connection_id!=self.connection_id or self.armed or not self.established:raise BridgeError('LIVE_ARM_CORRESPONDENCE')
        if not all(sum(e['role']==role and e['kind']=='LIVE_PROFILE' and e['pid']==self.children[role].pid for e in self.events)==1 for role in ('go','java')):raise BridgeError('LIVE_PROFILE_NOT_ATTESTED')
        self.armed=True;self.gate.resume()

    def reconnect(self,restart_role='none'):
        self.transport.drain()
        if restart_role not in ('none','go','java') or not self.armed or self.reconnecting or self.gate.pending:raise BridgeError('LIVE_RECONNECT_UNRESOLVED')
        if self.connection_count>=8:raise BridgeError('LIVE_CONNECTION_QUOTA')
        self.gate.suspend();self.armed=False;self.reconnecting=True
        mark=self.mark();before=dict(self.connections);previous=self.connection_id
        try:
            if restart_role!='none':self.checkpoint_kill(restart_role,1,1)
            self.transport.disconnect()
            if restart_role!='none':self.restart(restart_role)
            deadline=time.monotonic()+15
            for role in ('go','java'):
                self.wait(role,'LOGON',after=mark,timeout=max(.001,deadline-time.monotonic()),predicate=lambda e,r=role:e['pid']==self.children[r].pid)
            if any(self.connections[role]!=before[role]+1 for role in ('go','java')):raise BridgeError('LIVE_RECONNECT_CORRESPONDENCE')
            if restart_role!='none':self.prove_restart(restart_role)
            self.connection_id=str(uuid4())
            if self.connection_id in self.connection_ids:raise BridgeError('LIVE_CONNECTION_IDENTITY')
            self.connection_ids.add(self.connection_id);self.connection_count+=1
            return {'version':1,'profile':PROFILE,'kind':'CONNECTED','run_id':self.identity,'session_id':self.session_id,'store_id':self.store_id,'connection_id':self.connection_id,'previous_connection_id':previous,'runtime_hash':self.runtime_hash,'store_hash':self.store_hash,'go_pid':str(self.children['go'].pid),'java_pid':str(self.children['java'].pid)}
        finally:self.reconnecting=False

    def _publish(self,event):
        event={**event,'session_id':self.session_id,'store_id':self.store_id,'connection_id':self.connection_id}
        if event['kind']=='OBSERVED':event['sender_pid']=str(self.children['java' if event['direction']=='J_TO_G' else 'go'].pid)
        self.emit(event)

    def emit(self,event):
        # Control envelopes and application evidence use the same owned budget.
        with self.publish_lock:
            size=len(encode_envelope(event['kind'],**{k:v for k,v in event.items() if k not in ('version','profile','kind')}))
            if self.bridge_bytes+size+self.owner.budget()+self.output_bytes>MAX_RUNTIME_BYTES:raise BridgeError('LIVE_AGGREGATE_BUDGET')
            self.publish(event);self.bridge_bytes+=size

    def check_budget(self):
        if self.bridge_bytes+self.owner.budget()+self.output_bytes>MAX_RUNTIME_BYTES:raise BridgeError('LIVE_AGGREGATE_BUDGET')

    def child_event(self,event,payload):
        if event['kind']=='LOGON' and self.established and not self.reconnecting:
            self.gate.suspend();self.armed=False;self.fail('LIVE_UNREGISTERED_CONNECTION');return
        if event['kind']!='LIVE_APP':return
        role=event['role'];self.callback_ordinals[role]+=1
        try:self.gate.callback(role,payload.encode('ascii'),self.callback_ordinals[role],process_pid=event['pid'])
        except BridgeError as error:self.fail('LIVE_'+str(error))

    def send(self,role,fields):
        if not self.armed:raise BridgeError('LIVE_NOT_ARMED')
        self.gate.expire();super().send(role,fields)

    def _close(self,kind,value,trace):
        if self.gate.pending_application:self.errors.append('LIVE_APPLICATION_UNRESOLVED')
        try:self.transport.drain()
        except BridgeError as error:self.errors.append(str(error))
        return super()._close(kind,value,trace)

    def emit_receipt(self):
        # Keep the engine receipt separate from SQL financial verification. The
        # outer protocol will export bounded summaries, never relabel this receipt.
        self.check_budget()
        self.receipt.update(profile=PROFILE,session_id=self.session_id,store_id=self.store_id,connection_id=self.connection_id,runtime_hash=self.runtime_hash,store_hash=self.store_hash,bridge_bytes=self.bridge_bytes)

def _uuid(value):
    try:
        if not isinstance(value,str) or str(UUID(value))!=value:raise ValueError()
    except (ValueError,AttributeError):raise BridgeError('COMMAND_IDENTITY') from None
    return value

def main():
    parser=argparse.ArgumentParser()
    for name in ['root','run-id','session-id','store-id','connection-id','runtime-hash']:parser.add_argument('--'+name,required=True)
    args=parser.parse_args()
    stop=threading.Event();commands=queue.Queue(16);failures=queue.Queue(1);seen={}
    channel=OutputChannel(1);reader=None;lab=None;prior_stdin=os.get_blocking(0);os.set_blocking(0,False)
    def failed(code):
        try:failures.put_nowait(code)
        except queue.Full:pass
        stop.set()
    def receive(lab):
        buffer=bytearray()
        try:
            while not stop.is_set():
                if not select.select([0],[],[],.05)[0]:continue
                try:chunk=os.read(0,8192)
                except BlockingIOError:continue
                if not chunk:raise BridgeError('INPUT_EOF')
                buffer.extend(chunk)
                while b'\n' in buffer:
                    end=buffer.index(10)+1;line=bytes(buffer[:end]);del buffer[:end]
                    value=decode_line(line);kind=value['kind']
                    allowed={'ARM':{'connection_id'},'ACK':{'connection_id','observation_id','phase'},'SEND':{'connection_id','command_id','role','fields'},'RECONNECT':{'connection_id','command_id','restart_role'},'STOP':{'connection_id'}}.get(kind)
                    if allowed is None or set(value)!={'version','profile','kind'}|allowed:raise BridgeError('COMMAND_SHAPE')
                    if value['connection_id']!=lab.connection_id:raise BridgeError('COMMAND_CONNECTION')
                    if kind=='STOP':stop.set();return
                    if kind=='ACK':
                        lab.gate.ack(_uuid(value['observation_id']),value['phase']);continue
                    if kind=='ARM':
                        lab.arm(value['connection_id']);lab.emit({'version':1,'profile':PROFILE,'kind':'ARMED','session_id':lab.session_id,'store_id':lab.store_id,'connection_id':lab.connection_id});continue
                    _uuid(value['command_id'])
                    if kind=='RECONNECT':
                        if value['restart_role'] not in ('none','go','java'):raise BridgeError('RECONNECT_PROFILE')
                        try:commands.put_nowait(value)
                        except queue.Full:raise BridgeError('INPUT_QUEUE_FULL') from None
                        continue
                    fields=value['fields']
                    if value['role'] not in ('go','java') or not isinstance(fields,dict) or not 1<=len(fields)<=61:raise BridgeError('SEND_PROFILE')
                    if any(not re.fullmatch('[1-9][0-9]{0,4}',tag) or not isinstance(v,str) or not re.fullmatch('[ -~]{1,256}',v) for tag,v in fields.items()):raise BridgeError('SEND_PROFILE')
                    if fields.get('35') not in ('D','8','F','9'):raise BridgeError('SEND_PROFILE')
                    try:commands.put_nowait(value)
                    except queue.Full:raise BridgeError('INPUT_QUEUE_FULL') from None
                if len(buffer)>=MAX_ENVELOPE:raise BridgeError('ENVELOPE_BOUND')
        except (OSError,ValueError) as error:failed(str(error) if isinstance(error,BridgeError) else 'INPUT_IO')
    def interrupted(unused_signal,unused_frame):failed('BRIDGE_INTERRUPTED')
    signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
    try:
        with LiveRuntime(Path(args.root),args.run_id,args.session_id,args.store_id,args.connection_id,args.runtime_hash,channel.emit) as lab:
            lab.start()
            lab.emit({'version':1,'profile':PROFILE,'kind':'READY','run_id':lab.identity,'session_id':lab.session_id,'store_id':lab.store_id,'connection_id':lab.connection_id,'runtime_hash':lab.runtime_hash,'store_hash':lab.store_hash,'go_pid':str(lab.children['go'].pid),'java_pid':str(lab.children['java'].pid)})
            arm_deadline=time.monotonic()+5
            reader=threading.Thread(target=receive,args=(lab,),daemon=True);reader.start()
            while not stop.is_set():
                if channel.error:raise BridgeError(channel.error)
                if lab.errors:raise BridgeError('LIVE_RUNTIME_UNRESOLVED')
                lab.check_budget()
                if not lab.armed and time.monotonic()>=arm_deadline:raise BridgeError('ARM_DEADLINE')
                lab.gate.expire()
                try:command=commands.get(timeout=.01)
                except queue.Empty:continue
                key=command['command_id']
                if key in seen:raise BridgeError('SEND_ALREADY_DISPATCHED_UNRESOLVED')
                if len(seen)>=640:raise BridgeError('SEND_INTENT_QUOTA')
                seen[key]=hashlib.sha256(json.dumps(command,sort_keys=True,separators=(',',':')).encode('ascii')).hexdigest()
                if command['kind']=='RECONNECT':
                    if not commands.empty():raise BridgeError('RECONNECT_COMMANDS_PENDING')
                    lab.emit(lab.reconnect(command['restart_role']));arm_deadline=time.monotonic()+5;commands.task_done();continue
                lab.send(command['role'],command['fields']);commands.task_done()
            if not failures.empty():raise BridgeError(failures.get_nowait())
        lab.emit({'version':1,'profile':PROFILE,'kind':'STOPPED','session_id':lab.session_id,'store_id':lab.store_id,'connection_id':lab.connection_id,'pending':lab.gate.pending,'financial_application_verified':False,'transport_evidence_complete':lab.receipt['transport_evidence_complete'],'child_exit_codes':lab.receipt['child_exit_codes']})
        channel.flush()
        return 0
    except BaseException as error:
        code=str(error) if isinstance(error,(BridgeError,LabError)) and re.fullmatch('[A-Z0-9_]{1,100}',str(error)) else 'LIVE_BRIDGE_FAILURE'
        try:
            event={'version':1,'profile':PROFILE,'kind':'ERROR','code':code}
            if lab is None:channel.emit(event)
            else:lab.emit(event)
            channel.flush()
        except (OSError,ValueError):pass
        sys.stderr.write('LIVE_BRIDGE_FAILED '+code+'\n')
        return 2
    finally:
        stop.set()
        if reader:reader.join(timeout=1)
        channel.close();os.set_blocking(0,prior_stdin)

if __name__=='__main__':raise SystemExit(main())
