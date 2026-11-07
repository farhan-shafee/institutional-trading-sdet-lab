"""Authored oracle controls, not evidence that an engine actually ran."""
import copy,hashlib,json,unittest
from datetime import datetime,timezone
from pathlib import Path
from uuid import uuid4
from fix_live_application import verify

ROOT=Path(__file__).resolve().parents[2]
def fixture():
    row=next(r for r in json.loads((ROOT/'test-data/fix44/live/manifest.json').read_text()) if r['name']=='new-buy-ust')
    f=row['fields'];sid,run,session,store,conn,observation,message,observe_key,accept_key,actor=[str(uuid4()) for unused in range(10)];order=f['11'];runtime_hash='a'*64
    identity={'run_id':run,'session_id':session,'store_id':store,'runtime_hash':runtime_hash}
    metadata={'version':1,'profile':'live-fix-ingress-v1',**identity}
    store_hash=hashlib.sha256(json.dumps(metadata,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    observed={'sandbox_id':sid,'id':observation,'order_id':order,'connection_id':conn,'direction':'OUT','raw_hex':row['raw_hex'],'raw_hash':row['sha256'],'profile_valid':True,'observed_at':datetime.strptime(f['52'],'%Y%m%d-%H:%M:%S.%f').replace(tzinfo=timezone.utc).isoformat()}
    callback={'sandbox_id':sid,'observation_id':observation,'order_id':order,'connection_id':conn,'role':'go','event_seq':1,'callback_hex':row['raw_hex'],'callback_hash':row['sha256'],'message_id':message}
    observe={'order_id':order,'observation_id':observation,'connection_id':conn,'direction':'OUT','raw_hex':row['raw_hex']}
    accept={'order_id':order,'observation_id':observation,'connection_id':conn,'role':'go','event_seq':'1','callback_hex':row['raw_hex']}
    witness={'profile':'live-fix-ingress-v1','runtime_hash':runtime_hash,'session_id':session,'store_id':store,'connection_id':conn,'role':'go','pid':'100','event_seq':'1','callback_hash':row['sha256']}
    requests=[{'idempotency_key':key,'action':action,'request':payload} for key,action,payload in [(observe_key,'OBSERVE',observe),(accept_key,'ACCEPT',accept)]]
    journal_requests=[{'id':r['idempotency_key'],'value':{'kind':'COMMAND','action':r['action'],'sandbox_id':sid,'actor_id':actor,'order_id':order,'input':r['request'],**({'witness':witness} if r['action']=='ACCEPT' else {})}} for r in requests]
    snapshot={'profile':'fix-live-evidence-v1','physical_schema_revision':9,'sandbox_id':sid,
      'bindings':[{'sandbox_id':sid,'order_id':order,'session_id':session,'profile':'live-fix-ingress-v1'}],
      'sessions':[{'id':session,'store_id':store,'runtime_hash':runtime_hash,'store_hash':store_hash}],
      'connections':[{'id':conn,'session_id':session,'go_pid':100,'java_pid':101,'actor_id':actor,'generation':1,'connection_no':1}],
      'observations':[observed],'callbacks':[callback],
      'slots':[{'store_id':store,'direction':'OUT','message_seq':int(f['34']),'message_id':message,'first_observation_id':observation}],
      'messages':[{'id':message,'order_id':order,'fields':f,'message_type':'D','execution_id':None,'source_event_id':None}],
      'requests':requests,'work':[],'prepared':[],'applications':[],'protocol_observations':[],'consumptions':[],'orders':[],'positions':[],'ledger_executions':[]}
    for key in ['sessions','connections','slots','messages','requests']:
        for record in snapshot[key]:record['sandbox_id']=sid
    contract={'financial_source':'6016fb700840d081fe1fba651c918f0a7e709383','valuation_model_version':'phase1-regular-coupon-v1','instrument_id':f['55'],'instrument_revision':'phase1-ust-1','side':'BUY','clean_price':f['44'],'par_amount':f['38'],'settlement_date':f['64'][:4]+'-'+f['64'][4:6]+'-'+f['64'][6:]}
    snapshot['orders']=[{'order':{'id':order,'contract':contract},'lifecycle':{'filled_par':'0.00','executed_cents':'0','execution_count':0},'executions':[]}]
    journal={'identity':identity,'request':journal_requests,'work':[],
      'frame':[{'id':observation,'value':{'order_id':order,'raw_hex':row['raw_hex'],'connection_id':conn,'direction':'J_TO_G','sender_pid':'101','observe_key':observe_key,'accept_key':accept_key}}]}
    return {'snapshot':snapshot,'journal':journal}

class LiveApplicationOracleTests(unittest.TestCase):
    def test_literal_metadata_is_consistent_but_cannot_claim_financial_application(self):
        result=verify(fixture());self.assertEqual(result['findings'],[]);self.assertEqual(result['executions'],0);self.assertFalse(result['financial_application_verified'])
    def check(self,change,code):
        document=fixture();change(document);result=verify(document)
        self.assertIn(code,{f['code'] for f in result['findings']});self.assertFalse(result['financial_application_verified'])
    def test_missing_callback_witness_is_not_inferred_from_sql_or_sequence(self):
        self.check(lambda d:d['journal']['request'][-1]['value'].pop('witness'),'LIVE_NATIVE_WITNESS')
    def test_changed_registered_process_cannot_keep_a_native_witness(self):
        self.check(lambda d:d['snapshot']['connections'][0].update(go_pid=999),'LIVE_NATIVE_PROCESS')
    def test_original_request_key_cannot_describe_different_callback_bytes(self):
        def change(d):
            # Break aliasing in this authored fixture before mutating one retained intent.
            r=d['journal']['request'][-1]['value'];r['input']=copy.deepcopy(r['input']);r['input']['callback_hex']='61'
        self.check(change,'LIVE_JOURNAL_CONTEXT')
    def test_a_rehashed_malformed_observation_still_fails_independent_wire_validation(self):
        def change(d):
            o=d['snapshot']['observations'][0];raw=bytes.fromhex(o['raw_hex']);raw=b'9'+raw[1:];o.update(raw_hex=raw.hex(),raw_hash=hashlib.sha256(raw).hexdigest())
        self.check(change,'LIVE_WIRE')
    def test_legacy_snapshot_identity_cannot_be_relabelled_live(self):
        self.check(lambda d:d['snapshot'].update(physical_schema_revision=8,profile='fix-application-v2'),'LIVE_SNAPSHOT_DOMAIN')

if __name__=='__main__':unittest.main()
