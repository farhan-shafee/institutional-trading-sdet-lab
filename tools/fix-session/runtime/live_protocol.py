"""Bounded local bridge mechanics. No SQL, economic mapping or FIX state machine."""
import json
import os
import queue
import select
import threading
import time
from collections import deque
from uuid import uuid4

from wire import decode_frame,WireError

PROFILE='live-fix-ingress-v1'
MAX_ENVELOPE=24576
MAX_QUEUE=16
ACK_SECONDS=5.0
MAX_BYTES=64*1024*1024

class BridgeError(ValueError):pass

def _pairs(items):
    result={}
    for key,value in items:
        if key in result:raise BridgeError('ENVELOPE_DUPLICATE_KEY')
        result[key]=value
    return result

def _constant(unused):raise BridgeError('ENVELOPE_NUMBER')

def decode_line(line):
    if not isinstance(line,bytes) or not 1<=len(line)<=MAX_ENVELOPE or not line.endswith(b'\n'):
        raise BridgeError('ENVELOPE_BOUND')
    try:value=json.loads(line.decode('ascii'),object_pairs_hook=_pairs,parse_constant=_constant)
    except (ValueError,UnicodeError):raise BridgeError('ENVELOPE_JSON') from None
    if not isinstance(value,dict) or type(value.get('version')) is not int or value['version']!=1 or value.get('profile')!=PROFILE or not isinstance(value.get('kind'),str):
        raise BridgeError('ENVELOPE_PROFILE')
    return value

def _encode(value):
    try:line=(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True,allow_nan=False)+'\n').encode('ascii')
    except (ValueError,TypeError):raise BridgeError('ENVELOPE_JSON') from None
    decode_line(line)
    return line

def encode_envelope(kind,**fields):
    if set(fields)&{'version','profile','kind'}:raise BridgeError('ENVELOPE_RESERVED_FIELD')
    return _encode({'version':1,'profile':PROFILE,'kind':kind,**fields})

class OutputChannel:
    """The caller only queues. The owned writer bounds actual pipe progress."""
    def __init__(self,fd):
        self.fd=fd;self.queue=queue.Queue(MAX_QUEUE);self.stop=threading.Event();self.error=None
        self.bytes=0;self.lock=threading.Lock();self.previous_blocking=os.get_blocking(fd)
        os.set_blocking(fd,False)
        self.thread=threading.Thread(target=self._write,daemon=True);self.thread.start()

    @property
    def alive(self):return self.thread.is_alive()

    def emit(self,event):
        raw=_encode(event)
        with self.lock:
            if self.stop.is_set() or self.error:raise BridgeError('OUTPUT_UNAVAILABLE')
            if self.bytes+len(raw)>MAX_BYTES:raise BridgeError('OUTPUT_BUDGET')
            try:self.queue.put_nowait(raw)
            except queue.Full:raise BridgeError('OUTPUT_QUEUE_FULL') from None
            self.bytes+=len(raw)

    def _write(self):
        try:
            while not self.stop.is_set():
                try:raw=memoryview(self.queue.get(timeout=.05))
                except queue.Empty:continue
                deadline=time.monotonic()+ACK_SECONDS
                while raw and not self.stop.is_set():
                    remaining=deadline-time.monotonic()
                    if remaining<=0:raise BridgeError('OUTPUT_DEADLINE')
                    if not select.select([], [self.fd], [], min(remaining,.05))[1]:continue
                    try:n=os.write(self.fd,raw)
                    except BlockingIOError:continue
                    if n<=0:raise BridgeError('OUTPUT_IO')
                    raw=raw[n:]
                self.queue.task_done()
        except (OSError,ValueError) as error:
            self.error=str(error) if isinstance(error,BridgeError) else 'OUTPUT_IO';self.stop.set()

    def close(self):
        self.stop.set();self.thread.join(timeout=1)
        if self.thread.is_alive():raise BridgeError('OUTPUT_SHUTDOWN')
        os.set_blocking(self.fd,self.previous_blocking)

    def flush(self):
        deadline=time.monotonic()+ACK_SECONDS
        with self.queue.all_tasks_done:
            while self.queue.unfinished_tasks:
                if self.error or self.stop.is_set():raise BridgeError('OUTPUT_UNAVAILABLE')
                remaining=deadline-time.monotonic()
                if remaining<=0:raise BridgeError('OUTPUT_DEADLINE')
                self.queue.all_tasks_done.wait(min(remaining,.05))

class LaneGate:
    """FIFO application holds; only a durable acknowledgment releases each phase."""
    def __init__(self,emit,now=time.monotonic):
        self.emit=emit;self.now=now;self.lock=threading.RLock();self.lanes={'J_TO_G':deque(),'G_TO_J':deque()};self.failed=False;self.active=True

    def suspend(self):
        with self.lock:self._healthy();self.active=False

    def resume(self):
        with self.lock:
            self.expire();self.active=True
            for lane in self.lanes.values():
                if lane and lane[0]['phase']=='UNARMED':self._start(lane[0])

    @property
    def pending(self):
        with self.lock:return sum(len(lane) for lane in self.lanes.values())

    @property
    def pending_application(self):
        with self.lock:return sum(entry['fields']['35'] in ('D','8','F','9') for lane in self.lanes.values() for entry in lane)

    def _failure(self,code):
        self.failed=True
        raise BridgeError(code)

    def _healthy(self):
        if self.failed:raise BridgeError('LANE_UNRESOLVED')

    def _start(self,entry):
        if entry['fields']['35'] not in ('D','8','F','9'):
            entry['phase']='ADMIN';entry['deadline']=self.now()+ACK_SECONDS
            entry['forward'](entry['raw']);return
        if not self.active:
            entry['phase']='UNARMED';entry['deadline']=self.now()+ACK_SECONDS;return
        entry['phase']='OBSERVE';entry['deadline']=self.now()+ACK_SECONDS
        self.emit({'version':1,'profile':PROFILE,'kind':'OBSERVED','observation_id':entry['id'],'direction':entry['direction'],'raw_hex':entry['raw'].hex()})

    def offer(self,direction,raw,forward):
        return self._offer(direction,raw,forward,False)

    def offer_admin(self,direction,raw,forward):
        return self._offer(direction,raw,forward,True)

    def _offer(self,direction,raw,forward,admin):
        with self.lock:
            self._healthy()
            if direction not in self.lanes or self.pending>=MAX_QUEUE:self._failure('APPLICATION_QUEUE_FULL')
            try:fields=decode_frame(raw)
            except WireError:self._failure('APPLICATION_WIRE')
            if (fields['35'] in ('D','8','F','9'))==admin:self._failure('APPLICATION_TYPE')
            entry={'id':str(uuid4()),'direction':direction,'raw':raw,'fields':fields,'forward':forward,'phase':'QUEUED'}
            lane=self.lanes[direction];lane.append(entry)
            if len(lane)==1:self._start(entry)
            return entry['id']

    def forwarded_admin(self,direction,raw):
        with self.lock:
            self.expire();lane=self.lanes.get(direction);entry=lane[0] if lane else None
            if entry is None or entry['phase']!='ADMIN' or entry['raw']!=raw:self._failure('ADMIN_CORRESPONDENCE')
            lane.popleft()
            if lane:self._start(lane[0])

    def expire(self):
        with self.lock:
            self._healthy()
            if any(lane and self.now()>=lane[0]['deadline'] for lane in self.lanes.values()):self._failure('APPLICATION_ACK_DEADLINE')

    def ack(self,observation_id,phase):
        with self.lock:
            self.expire()
            entry=next((lane[0] for lane in self.lanes.values() if lane and lane[0]['id']==observation_id),None)
            if entry is None or phase!=entry['phase'] or phase not in ('OBSERVE','ACCEPT'):self._failure('ACK_CORRESPONDENCE')
            if phase=='OBSERVE':
                entry['phase']='FORWARDED';entry['deadline']=self.now()+ACK_SECONDS
                entry['forward'](entry['raw'])
            else:
                lane=self.lanes[entry['direction']];lane.popleft()
                if lane:self._start(lane[0])

    def callback(self,role,raw,event_seq,process_pid=None):
        with self.lock:
            self.expire()
            direction='J_TO_G' if role=='go' else 'G_TO_J' if role=='java' else None
            lane=self.lanes.get(direction);entry=lane[0] if lane else None
            if entry is None or entry['phase']!='FORWARDED' or type(event_seq) is not int or not 1<=event_seq<=1024:self._failure('CALLBACK_CORRESPONDENCE')
            if process_pid is not None and (type(process_pid) is not int or process_pid<=0):self._failure('CALLBACK_PROCESS')
            try:fields=decode_frame(raw)
            except WireError:self._failure('CALLBACK_WIRE')
            omit={'8','9','10'}
            if {k:v for k,v in fields.items() if k not in omit}!={k:v for k,v in entry['fields'].items() if k not in omit}:self._failure('CALLBACK_CORRESPONDENCE')
            entry['phase']='ACCEPT';entry['deadline']=self.now()+ACK_SECONDS
            self.emit({'version':1,'profile':PROFILE,'kind':'CALLBACK','observation_id':entry['id'],'role':role,'event_seq':str(event_seq),'callback_hex':raw.hex(),**({'receiver_pid':str(process_pid)} if process_pid is not None else {})})
