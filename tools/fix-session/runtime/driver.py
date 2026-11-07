"""Owned local session laboratory. Session state machines belong to the two engines."""
import base64
from datetime import datetime,timezone
import hashlib
import json
import os
from pathlib import Path
import re
import select
import socket
import subprocess
import sys
import threading
import time
from uuid import uuid4

sys.path.insert(0,str(Path(__file__).parent))
from wire import Framer,decode_frame,WireError
from ownership import StoreOwner,check_configuration

class LabError(RuntimeError):pass

HEADER_FIELDS=set('8 9 10 35 49 56 34 43 52 122'.split())
BODY_FIELDS={
    'A':'98 108 141', '0':'112', '1':'112', '2':'7 16',
    '3':'45 371 372 373 58', '4':'36 123', '5':'58',
    'D':'11 21 55 167 54 60 38 40 44 59 15 64 854 423',
    '8':'37 17 150 39 11 55 167 54 38 40 44 15 64 14 151 6 60 854 423 32 31 58',
    'F':'41 11 55 54 60 38', '9':'37 11 41 39 434 102 58',
}

def timestamp(value):
    if not isinstance(value,str) or not re.fullmatch(r'[0-9]{8}-[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.(?:[0-9]{3}|[0-9]{6}|[0-9]{9}))?',value):
        raise LabError('TIMESTAMP_FORMAT')
    try:datetime.strptime(value[:17],'%Y%m%d-%H:%M:%S')
    except ValueError:raise LabError('TIMESTAMP_FORMAT') from None
    return value[:17]+'.'+(value[18:] if len(value)>17 else '').ljust(9,'0')

class FaultTransport:
    def __init__(self,lab):
        self.lab=lab;self.listener=None;self.sockets=[];self.stop=threading.Event();self.thread=None
        self.frames=[];self.lock=threading.Lock();self.cv=threading.Condition(self.lock);self.send_lock=threading.Lock()
        self.rules=[];self.identities={};self.held=[]

    def start(self):
        self.listener=socket.socket();self.listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
        self.listener.bind(('127.0.0.1',19875));self.listener.listen(1);self.listener.settimeout(.1)
        self.thread=threading.Thread(target=self.run,daemon=True);self.thread.start()

    def record(self,direction,stage,raw):
        fields=decode_frame(raw)
        with self.lock:
            if len(self.frames)>=512:raise LabError('WIRE_OBSERVATION_LIMIT')
            observation={'direction':direction,'stage':stage,'fields':fields,'raw_hex':raw.hex(),'sha256':hashlib.sha256(raw).hexdigest(),'at':time.monotonic()}
            self.frames.append(observation)
            with (self.lab.root/'wire.jsonl').open('a',encoding='utf-8') as out:
                out.write(json.dumps(observation,sort_keys=True)+'\n')
        self.lab.owner.budget()
        return fields

    def admit(self,direction,fields):
        expected=('TRADEFLOW','ATLAS') if direction=='J_TO_G' else ('ATLAS','TRADEFLOW')
        if (fields['49'],fields['56'])!=expected:raise LabError('COMP_ID_MISMATCH')
        msg=fields['35']
        if msg not in ('A','0','1','2','3','4','5','D','8','F','9'):raise LabError('MESSAGE_UNSUPPORTED')
        if set(fields)-HEADER_FIELDS-set(BODY_FIELDS[msg].split()):raise LabError('FIELD_UNSUPPORTED')
        sent_at=timestamp(fields['52'])
        if msg=='A' and (fields.get('98')!='0' or fields.get('108')!='30' or fields.get('141','N')!='N'):raise LabError('LOGON_PROFILE')
        if msg=='4' and fields.get('123')!='Y':raise LabError('RESET_UNSUPPORTED')
        if msg=='4' and (not re.fullmatch(r'[1-9][0-9]{0,9}',fields.get('36','')) or not int(fields['34'])<int(fields['36'])<=2147483647):raise LabError('INVALID_GAP_FILL')
        if fields.get('43','N') not in ('Y','N') or ('122' in fields and fields.get('43')!='Y'):raise LabError('REPLAY_HEADER')
        if fields.get('43')=='Y' and (not fields.get('122') or timestamp(fields['122'])>sent_at):raise LabError('REPLAY_HEADER')
        if msg in ('D','8','F','9'):
            identity=fields.get('17') if msg=='8' else fields.get('11')
            if not identity:raise LabError('APPLICATION_ID_REQUIRED')
            key=(direction,msg,identity)
            economic={k:v for k,v in fields.items() if k not in ('8','9','10','34','43','52','122')}
            if key in self.identities and self.identities[key]!=economic:raise LabError('DUPLICATE_CONFLICT')
            self.identities[key]=economic

    def run(self):
        try:
            while not self.stop.is_set():
                try:left,_=self.listener.accept()
                except socket.timeout:continue
                if self.stop.is_set():left.close();break
                right=socket.create_connection(('127.0.0.1',19876),timeout=2)
                left.settimeout(2);right.settimeout(2)
                self.sockets=[left,right];framers={left:Framer(),right:Framer()}
                try:
                    while not self.stop.is_set():
                        readable,_,_=select.select([left,right],[],[],.1)
                        disconnected=False
                        for source in readable:
                            chunk=source.recv(8192)
                            if not chunk:
                                framers[source].finish();disconnected=True;break
                            target=right if source is left else left
                            direction='J_TO_G' if source is left else 'G_TO_J'
                            frames=framers[source].feed(chunk)
                            while True:
                                for raw in frames:
                                    fields=self.record(direction,'sender_observed',raw)
                                    self.admit(direction,fields)
                                    action=None
                                    with self.lock:
                                        for index,rule in enumerate(self.rules):
                                            if rule['direction']==direction and rule['type']==fields['35']:
                                                action=self.rules.pop(index)['action'];break
                                    if action=='drop':continue
                                    if action=='hold':
                                        with self.cv:
                                            if len(self.held)>=16:raise LabError('HELD_FRAME_LIMIT')
                                            self.held.append({'raw':raw,'fields':fields,'target':target,'direction':direction,'released':False})
                                            self.cv.notify_all()
                                        self.record(direction,'held_bytes',raw)
                                        continue
                                    with self.send_lock:target.sendall(raw)
                                    self.record(direction,'forwarded_bytes',raw)
                                if not framers[source].blocked:break
                                frames=framers[source].feed(b'')
                        if disconnected:break
                finally:
                    for channel in (left,right):
                        try:channel.close()
                        except OSError:pass
                    self.sockets=[]
        except (OSError,WireError,LabError) as error:
            if not self.stop.is_set():self.lab.fail('TRANSPORT_'+str(error) if isinstance(error,(WireError,LabError)) else 'TRANSPORT_IO')

    def drop_next(self,direction,msg):
        with self.lock:self.rules.append({'direction':direction,'type':msg,'action':'drop'})

    def hold_next(self,direction,msg):
        with self.lock:
            if len(self.rules)>=16:raise LabError('FAULT_RULE_LIMIT')
            self.rules.append({'direction':direction,'type':msg,'action':'hold'})

    def wait_held(self,index,timeout=15):
        if not isinstance(index,int) or not 0<=index<16:raise LabError('HELD_INDEX')
        deadline=time.monotonic()+timeout
        with self.cv:
            while len(self.held)<=index:
                if self.lab.errors:raise LabError(self.lab.errors[0])
                remaining=deadline-time.monotonic()
                if remaining<=0:raise LabError('HELD_FRAME_DEADLINE')
                self.cv.wait(min(remaining,.1))
            return {'fields':dict(self.held[index]['fields'])}

    def release_held(self,index):
        with self.lock:
            if not isinstance(index,int) or not 0<=index<len(self.held) or self.held[index]['released']:raise LabError('HELD_INDEX')
            entry=self.held[index];entry['released']=True
        try:
            with self.send_lock:entry['target'].sendall(entry['raw'])
        except OSError:raise LabError('HELD_TRANSPORT_IO') from None
        self.record(entry['direction'],'forwarded_bytes',entry['raw'])

    def disconnect(self):
        for channel in self.sockets:
            try:channel.shutdown(socket.SHUT_RDWR)
            except OSError:pass

    def close(self):
        self.stop.set();self.disconnect()
        if self.thread:self.thread.join(timeout=4)
        if self.listener:self.listener.close()

class Lab:
    def __init__(self,root,identity=None):
        check_configuration('127.0.0.1',19876,19875,False)
        self.root=Path(root);self.identity=identity or str(uuid4());self.owner=StoreOwner(self.root,self.identity)
        self.events=[];self.errors=[];self.cv=threading.Condition();self.children={};self.stderr={};self.closing=False;self.readers=[];self.output_bytes=0
        self.transport=FaultTransport(self);self.established=False;self._started=set()

    def __enter__(self):self.owner.__enter__();return self
    def __exit__(self,kind,value,trace):
        self.closing=True
        for role,process in self.children.items():
            if process.poll() is None:
                try:self.command(role,'STOP')
                except (OSError,LabError):pass
        forced=False
        for process in self.children.values():
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5);forced=True
            process.stdin.close()
        for reader in self.readers:
            reader.join(timeout=2)
            if reader.is_alive():self.errors.append('CHILD_READER_SHUTDOWN')
        for process in self.children.values():process.stdout.close()
        self.transport.close()
        for out in self.stderr.values():out.close()
        inventories={}
        for role in self.children:
            try:inventories[role]=self.owner.inventory(role)
            except ValueError:self.errors.append('STORE_FINAL_INVENTORY')
        codes={role:process.returncode for role,process in self.children.items()}
        if any(code!=0 for code in codes.values()):self.errors.append('CHILD_NONZERO')
        if forced:self.errors.append('OWNED_CHILD_FORCED_CLEANUP')
        if not (self.established and set(self.children)=={'java','go'} and all(self.count(role,'LOGON')>0 for role in ('java','go')) and self.transport.frames and set(inventories)=={'java','go'}):
            self.errors.append('RUNTIME_NOT_ESTABLISHED')
        self.receipt={
            'version':1,'run_id':self.identity,**self.claims(),
            'transport_evidence_complete':kind is None and not self.errors,
            'synthetic_peer_callback_count':sum(e['kind']=='APP' for e in self.events),
            'errors':list(self.errors),'child_exit_codes':codes,
            'processes':{role:{'pid':process.pid} for role,process in self.children.items()},
            'config_sha256':{role:hashlib.sha256((self.root/(role+'.cfg')).read_bytes()).hexdigest() for role in self.children},
            'store_inventory':inventories,'wire':list(self.transport.frames),'events':list(self.events),
        }
        # The outer gate captures this bounded synthetic evidence, including failures.
        print('LAB_RECEIPT\t'+json.dumps(self.receipt,sort_keys=True),flush=True)
        self.owner.__exit__(kind,value,trace)
        if kind is None and self.errors:raise LabError(self.errors[0])

    def fail(self,code):
        with self.cv:self.errors.append(code);self.cv.notify_all()

    def mark(self):
        with self.cv:return len(self.events)
    def count(self,role,kind):return sum(e['role']==role and e['kind']==kind for e in self.events)

    def _reader(self,role,process):
        try:
            while True:
                line=process.stdout.readline(16385)
                if not line:break
                with self.cv:
                    self.output_bytes+=len(line)
                    if self.output_bytes>4*1024*1024:raise LabError('CHILD_OUTPUT_BUDGET')
                if len(line)>16384 or not line.endswith(b'\n'):raise LabError('CHILD_OUTPUT_BOUND')
                if not line.startswith(b'EVENT\t'):continue
                parts=line.rstrip(b'\r\n').split(b'\t')
                if len(parts)!=3:raise LabError('CHILD_EVENT')
                kind=parts[1].decode('ascii');payload=base64.b64decode(parts[2],validate=True).decode('ascii')
                if len(payload)>8192:raise LabError('CHILD_EVENT_BOUND')
                fields=dict(part.split('=',1) for part in payload.split('\x01') if '=' in part)
                with self.cv:
                    if len(self.events)>=1024:raise LabError('CHILD_EVENT_BUDGET')
                    self.events.append({'role':role,'kind':kind,'fields':fields,'at':time.monotonic()});self.cv.notify_all()
                if kind=='ERROR':raise LabError('CHILD_RUNTIME_ERROR')
        except LabError as error:self.fail(str(error))
        except (ValueError,UnicodeError):self.fail('CHILD_PROTOCOL')
        finally:
            if not self.closing:self.fail('CHILD_EXIT_'+role)

    def wait(self,role,kind,after=0,timeout=15,predicate=None):
        deadline=time.monotonic()+timeout
        with self.cv:
            while True:
                if self.errors:raise LabError(self.errors[0])
                for event in self.events[after:]:
                    if event['role']==role and event['kind']==kind and (predicate is None or predicate(event)):
                        return event
                remaining=deadline-time.monotonic()
                if remaining<=0:raise LabError('EXPECTED_EVENT_DEADLINE_'+role+'_'+kind)
                self.cv.wait(remaining)

    def _config(self,role):
        common={'BeginString':'FIX.4.4','FileStorePath':str(self.root/role),'PersistMessages':'Y','FileStoreSync':'Y','UseDataDictionary':'Y','DataDictionary':'/lab/dictionary/FIX44.xml','ResetOnLogon':'N','ResetOnLogout':'N','ResetOnDisconnect':'N','RefreshOnLogon':'Y','CheckLatency':'Y','MaxLatency':'120','LogonTimeout':'5','LogoutTimeout':'5'}
        if role=='java':common.update({'ConnectionType':'initiator','SenderCompID':'TRADEFLOW','TargetCompID':'ATLAS','SocketConnectHost':'127.0.0.1','SocketConnectPort':'19875','HeartBtInt':'30','NonStopSession':'Y','ResetOnError':'N','ReconnectInterval':'1','SocketConnectTimeout':'5','ValidateChecksum':'Y','ValidateIncomingMessage':'Y','ValidateFieldsOutOfOrder':'Y'})
        else:common.update({'ConnectionType':'acceptor','SenderCompID':'ATLAS','TargetCompID':'TRADEFLOW','SocketAcceptHost':'127.0.0.1','SocketAcceptPort':'19876','HeartBtInt':'30'})
        defaults={k:v for k,v in common.items() if k not in ('BeginString','SenderCompID','TargetCompID')}
        text='[DEFAULT]\n'+''.join(k+'='+v+'\n' for k,v in defaults.items())+'[SESSION]\n'+''.join(k+'='+v+'\n' for k,v in common.items())
        path=self.root/(role+'.cfg');path.write_text(text,encoding='ascii');return path

    def spawn(self,role):
        path=self.root/role
        if self.owner.reopened or role in self._started:self.owner.verify(role)
        elif path.exists() and any(path.iterdir()):raise LabError('STORE_NOT_FRESH')
        path.mkdir(mode=0o700,exist_ok=True)
        config=self._config(role)
        if role=='java':args=['/opt/java/openjdk/bin/java','-Xmx128m','-XX:ActiveProcessorCount=1','-Djava.awt.headless=true','-Djava.io.tmpdir='+str(self.root),'-cp','/opt/runtime/classes:/opt/runtime/lib/*','tradeflow.SessionMain',str(config)]
        else:args=['/opt/runtime/peer',str(config)]
        out=(self.root/(role+'.stderr')).open('ab');self.stderr[role]=out
        env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','GOMAXPROCS':'1','GOMEMLIMIT':'128MiB'}
        process=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=out,env=env)
        self.children[role]=process;self._started.add(role)
        reader=threading.Thread(target=self._reader,args=(role,process),daemon=True)
        self.readers.append(reader);reader.start()
        self.wait(role,'READY')

    def start(self):
        self.spawn('go');self.transport.start();self.spawn('java')
        self.wait('java','LOGON');self.wait('go','LOGON');self.established=True

    def command(self,role,action,payload=''):
        if role not in self.children or action not in ('SEND','STATE','LOGOUT','STOP'):raise LabError('COMMAND')
        line=action+('\t'+payload if payload else '')+'\n'
        if len(line)>12000:raise LabError('COMMAND_BOUND')
        child=self.children[role]
        if child.poll() is not None:raise LabError('CHILD_NOT_RUNNING')
        child.stdin.write(line.encode('ascii'));child.stdin.flush()

    def send(self,role,fields):
        if not isinstance(fields,dict) or any(not isinstance(v,str) for v in fields.values()):raise LabError('EXACT_STRING_FIELDS')
        payload=''.join(k+'='+v+'\x01' for k,v in fields.items())
        self.command(role,'SEND',base64.b64encode(payload.encode('ascii')).decode('ascii'))

    def claims(self):
        return {'scope':'synthetic-local-selected-session-profile','financial_application_verified':False,'external_delivery_verified':False,'external_completeness_verified':False}

    def order_probe(self,order):
        now=datetime.now(timezone.utc).strftime('%Y%m%d-%H:%M:%S.%f')[:-3]
        return {'35':'D','11':order,'21':'1','55':'SYN-UST-2031','167':'TNOTE','54':'1','60':now,'38':'100.00','40':'2','44':'100.050000000123','59':'1','15':'USD','64':'20261109','854':'0','423':'1'}

    def ack_probe(self,order):
        now=datetime.now(timezone.utc).strftime('%Y%m%d-%H:%M:%S.%f')[:-3]
        return {'35':'8','37':'ATLAS-'+order.upper(),'17':'ATLAS-'+str(uuid4()).upper(),'150':'0','39':'0','11':order,'55':'SYN-UST-2031','167':'TNOTE','54':'1','38':'100.00','40':'2','44':'100.050000000123','15':'USD','64':'20261109','14':'0.00','151':'100.00','6':'0.000000000000','60':now,'854':'0','423':'1'}

    def cancel_probe(self,order,cancel):
        now=datetime.now(timezone.utc).strftime('%Y%m%d-%H:%M:%S.%f')[:-3]
        return {'35':'F','41':order,'11':cancel,'55':'SYN-UST-2031','54':'1','60':now,'38':'100.00'}

    def cancel_reject_probe(self,order,cancel):
        return {'35':'9','37':'ATLAS-'+order.upper(),'11':cancel,'41':order,'39':'0','434':'1','102':'0','58':'SYNTHETIC_TRANSPORT_ONLY'}
