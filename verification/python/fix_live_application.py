"""Independent live raw/dictionary/process/intent and rational ledger oracle.

SQL authenticates authority and reconstructs kernel effects. This program checks
the observed transcript and trusted local controller journal; it is not external
cryptographic provenance. No TypeScript or SQL financial helper is imported.
"""
import hashlib,json,re,sys
from collections import defaultdict
from datetime import datetime,timedelta,timezone
from fractions import Fraction
from fix_live import parse_live_wire
from execution_reference import execution_cents

PROFILE='live-fix-ingress-v1'
SOURCE='6016fb700840d081fe1fba651c918f0a7e709383'
OMIT={8,9,10,34,43,52,122}

def verify(document):
    issues=set()
    def finding(code,record='snapshot'):issues.add((code,str(record)))
    s=document['snapshot'];j=document['journal'];identity=j['identity'];sid=s['sandbox_id']
    if s.get('profile')!='fix-live-evidence-v1' or s.get('physical_schema_revision')!=9:
        finding('LIVE_SNAPSHOT_DOMAIN')
    sessions={x['id']:x for x in s['sessions']};connections={x['id']:x for x in s['connections']};bindings={x['order_id']:x for x in s['bindings']}
    observations={x['id']:x for x in s['observations']};messages={x['id']:x for x in s['messages']}
    originals={x['id']:x['value'] for x in j['request']};frames={x['id']:x['value'] for x in j['frame']};work_intents={x['id']:x['value'] for x in j['work']}
    sql_requests={x['idempotency_key']:x for x in s['requests']}
    orders={x['order']['id']:x for x in s['orders']}
    if len(bindings)>4 or len(observations)>640 or len(s['requests'])>1024:finding('LIVE_ORACLE_BOUND')
    for table in ['bindings','sessions','connections','observations','callbacks','slots','messages','requests','work','prepared','applications','protocol_observations','consumptions']:
        if len(s[table])>1024:finding('LIVE_ORACLE_BOUND',table)
        for row in s[table]:
            if row.get('sandbox_id')!=sid:finding('LIVE_SANDBOX_DOMAIN',table)
    for b in bindings.values():
        r=sessions.get(b['session_id']);oid=b['order_id']
        if b['profile']!=PROFILE or not r or r['id']!=identity['session_id'] or r['store_id']!=identity['store_id'] or r['runtime_hash']!=identity['runtime_hash']:
            finding('LIVE_RUNTIME_DOMAIN',oid);continue
        metadata={'version':1,'profile':PROFILE,**identity}
        expected=hashlib.sha256(json.dumps(metadata,sort_keys=True,separators=(',',':')).encode('ascii')).hexdigest()
        if r['store_hash']!=expected:finding('LIVE_STORE_IDENTITY',oid)
        if oid not in orders:finding('LIVE_ORDER_CONTRACT',oid)
    for key,r in sql_requests.items():
        retained=originals.get(key)
        if not retained or retained.get('sandbox_id')!=sid or retained.get('action')!=r['action'] or retained.get('input')!=r['request'] or retained.get('order_id')!=r['request'].get('order_id'):
            finding('LIVE_JOURNAL_CONTEXT',key)
    parsed={}
    for oid,o in observations.items():
        try:
            raw=bytes.fromhex(o['raw_hex']);f=parse_live_wire(raw);parsed[oid]=f
            if hashlib.sha256(raw).hexdigest()!=o['raw_hash']:finding('LIVE_RAW_HASH',oid)
            if o['direction']!=('OUT' if f[35] in ('D','F') else 'IN'):finding('LIVE_DIRECTION',oid)
            if (f.get(41) or f[11])!=o['order_id']:finding('LIVE_ORDER_REFERENCE',oid)
            sent=datetime.strptime(f[52],'%Y%m%d-%H:%M:%S.%f').replace(tzinfo=timezone.utc)
            observed=datetime.fromisoformat(o['observed_at'])
            if abs(sent-observed)>=timedelta(seconds=120):finding('LIVE_ARRIVAL_TIME',oid)
            if o['order_id'] in orders:
                contract=orders[o['order_id']]['order']['contract']
                expected={55:contract['instrument_id'],54:'1' if contract['side']=='BUY' else '2',38:contract['par_amount']}
                if f[35] in ('D','8'):expected.update({44:contract['clean_price'],64:contract['settlement_date'].replace('-',''),15:'USD',59:'1',854:'0',40:'2',423:'1'})
                if f[35]!='9' and any(f.get(k)!=v for k,v in expected.items()):finding('LIVE_ORDER_CONTRACT',oid)
        except (ValueError,KeyError,TypeError,OverflowError):finding('LIVE_WIRE',oid)
        frame=frames.get(oid);connection=connections.get(o['connection_id'])
        if not frame or frame.get('raw_hex')!=o['raw_hex'] or frame.get('connection_id')!=o['connection_id'] or frame.get('order_id')!=o['order_id']:
            finding('LIVE_JOURNAL_FRAME',oid)
        elif not connection or frame.get('sender_pid')!=str(connection['java_pid' if o['direction']=='OUT' else 'go_pid']):finding('LIVE_NATIVE_PROCESS',oid)
    accepted=set()
    for cb in s['callbacks']:
        oid=cb['observation_id'];o=observations.get(oid);connection=connections.get(cb['connection_id']);frame=frames.get(oid)
        accepted.add(oid)
        try:
            raw=bytes.fromhex(cb['callback_hex']);f=parse_live_wire(raw)
            if hashlib.sha256(raw).hexdigest()!=cb['callback_hash']:finding('LIVE_CALLBACK_HASH',oid)
            if oid not in parsed or {k:v for k,v in f.items() if k not in (8,9,10)}!={k:v for k,v in parsed[oid].items() if k not in (8,9,10)}:finding('LIVE_CALLBACK_CORRESPONDENCE',oid)
            message=messages.get(cb['message_id'])
            if not message or {str(k):v for k,v in f.items() if k not in OMIT}!={k:v for k,v in message['fields'].items() if int(k) not in OMIT}:finding('LIVE_MESSAGE_CORRESPONDENCE',oid)
        except (ValueError,KeyError,TypeError):finding('LIVE_CALLBACK_WIRE',oid)
        retained=originals.get(frame.get('accept_key')) if frame else None
        witness=retained.get('witness') if retained else None
        if not witness or not connection or not o:finding('LIVE_NATIVE_WITNESS',oid);continue
        expected={'profile':PROFILE,'runtime_hash':identity['runtime_hash'],'session_id':identity['session_id'],'store_id':identity['store_id'],'connection_id':cb['connection_id'],'role':cb['role'],'pid':str(connection['go_pid' if cb['role']=='go' else 'java_pid']),'event_seq':str(cb['event_seq']),'callback_hash':cb['callback_hash']}
        if witness.get('pid')!=expected['pid']:finding('LIVE_NATIVE_PROCESS',oid)
        if witness!=expected or connection['session_id']!=identity['session_id'] or retained.get('actor_id')!=connection['actor_id']:finding('LIVE_NATIVE_WITNESS',oid)
        if cb['role']!=('go' if o['direction']=='OUT' else 'java'):finding('LIVE_NATIVE_PROCESS',oid)
    executions=0;cash=0
    for oid,record in orders.items():
        contract=record['order']['contract'];life=record['lifecycle'];par=Fraction(0);cents=0
        if contract.get('financial_source')!=SOURCE or contract.get('valuation_model_version')!='phase1-regular-coupon-v1':finding('LIVE_FINANCIAL_DOMAIN',oid)
        actual={x['id']:x for x in record['executions']};expected={}
        for message in messages.values():
            f=message['fields']
            if message['order_id']!=oid or f.get('150')!='F':continue
            if any(a['message_id']==message['id'] for a in s['applications']):expected[message['execution_id']]=message
        if set(actual)!=set(expected):finding('LIVE_EXECUTION_CORRELATION',oid)
        for index,e in enumerate(record['executions'],1):
            message=expected.get(e['id'])
            if not message:continue
            f=message['fields']
            try:
                if not isinstance(e['par_amount'],str) or not isinstance(e['consideration_cents'],str):raise ValueError()
                quantity=Fraction(f['32']);amount=execution_cents(f['31'],f['32'],contract['instrument_revision'],contract['settlement_date'])
                par+=quantity;cents+=amount;executions+=1
                if e['source_event_id']!=message['source_event_id'] or e['order_id']!=oid or e['fill_sequence']!=index or Fraction(e['par_amount'])!=quantity or int(e['consideration_cents'])!=amount or e['clean_price']!=contract['clean_price'] or e['settlement_date']!=contract['settlement_date'] or e['instrument_revision']!=contract['instrument_revision'] or e['side']!=contract['side']:finding('LIVE_EXECUTION_CASH',e['id'])
                if f['31']!=contract['clean_price'] or Fraction(f['14'])!=par or Fraction(f['151'])!=Fraction(contract['par_amount'])-par: finding('LIVE_EXECUTION_CONTRACT',e['id'])
            except (ValueError,KeyError,TypeError,ZeroDivisionError):finding('LIVE_EXECUTION_CASH',e['id'])
        if Fraction(life['filled_par'])!=par or int(life['executed_cents'])!=cents or life['execution_count']!=len(actual):finding('LIVE_LIFECYCLE_TOTALS',oid)
        cash+=cents
    totals=defaultdict(lambda:[Fraction(0),0,0])
    for e in s['ledger_executions']:
        sign=1 if e['side']=='BUY' else -1;r=totals[e['instrument_revision']]
        if not isinstance(e['par_amount'],str) or not isinstance(e['consideration_cents'],str):finding('LIVE_DECIMAL_REPRESENTATION',e['id']);continue
        r[0]+=sign*Fraction(e['par_amount']);r[1]-=sign*int(e['consideration_cents']);r[2]+=1
    positions={p['instrument_revision']:p for p in s['positions']}
    if set(totals)!=set(positions):finding('LIVE_POSITION_TOTALS')
    for revision,p in positions.items():
        if [Fraction(p['signed_par']),int(p['signed_cash_cents']),p['execution_count']]!=totals[revision]:finding('LIVE_POSITION_TOTALS',revision)
    for a in s['applications']:
        work=next((w for w in s['work'] if w['id']==a['work_id']),None)
        plan=work_intents.get(a['message_id'])
        if not work or not plan or plan['work_id']!=a['work_id'] or plan['financial_key']!=a['financial_key'] or plan['order_id']!=a['order_id']:finding('LIVE_ORIGINAL_FINANCIAL_INTENT',a['work_id'])
    pending_requests=sum(key not in sql_requests for key in originals)
    resolved={a['message_id'] for a in s['applications']}
    resolved.update(w['message_id'] for w in s['work'] if any(o['work_id']==w['id'] for o in s['protocol_observations']))
    pending_messages=sum(m['message_type']!='D' and m['id'] not in resolved for m in messages.values())
    unresolved=len(set(observations)-accepted)+pending_requests+pending_messages
    findings=[{'code':code,'record_id':record} for code,record in sorted(issues)]
    return {'findings':findings[:128],'total_findings':len(findings),'executions':executions,'cash_cents':str(cash),'unresolved':unresolved,'financial_application_verified':not findings and unresolved==0 and len(s['applications'])>0}

if __name__=='__main__':
    raw=sys.stdin.buffer.read(64*1024*1024+1)
    if len(raw)>64*1024*1024:raise ValueError('LIVE_ORACLE_BOUND')
    print(json.dumps(verify(json.loads(raw))))
