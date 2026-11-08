"""Additional schema10 native journey. Original gates and exact preservation stay independent."""
import hashlib,importlib.util,json,os,re,signal,subprocess,sys,time
from pathlib import Path
from uuid import UUID,uuid4
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools/fix-session'))
from gate import GateError,admit_pins,require_tool,input_identity,require_same_inputs,verify_preserved,run_bounded
from preservation_v3 import load_preservation
from preservation_v3_controls import admit_control_receipt
spec=importlib.util.spec_from_file_location('original_live_gate',ROOT/'scripts/test-fix-live-application.py')
original=importlib.util.module_from_spec(spec);spec.loader.exec_module(original)

def main():
    identity=str(uuid4());scope='synthetic-posttrade-native';started=time.monotonic()
    out=ROOT/'artifacts'/('posttrade-native-'+identity);out.mkdir(parents=True,mode=0o700)
    private=ROOT/'.local'/'posttrade-native-gates'/identity
    for directory in [ROOT/'.local',private.parent,private]:directory.mkdir(exist_ok=True,mode=0o700)
    evidence=private/'cases';evidence.mkdir(mode=0o700)
    image='tradeflow-posttrade-native:run-'+identity;pointer=out/'postgres-owner.txt'
    report={'version':1,'profile':'owned-posttrade-native-v1','physical_schema_revision':10,'run_id':identity,'status':'failed','external_delivery_verified':False}
    docker=node=None;runtime_image=None;image_intended=False;cleaning=False;primary=None
    def write(name,value):(out/name).write_text(json.dumps(value,sort_keys=True,indent=2)+'\n',encoding='utf8')
    write('owner.json',{'version':1,'run_id':identity,'scope':scope})
    def budget():
        used=original.evidence_bytes(out)+original.evidence_bytes(private)
        if used>8388608:raise GateError('POSTTRADE_EVIDENCE_BUDGET')
        journals=0
        for intent in (evidence/'engine-intents').glob('*.json'):
            data=json.loads(intent.read_text());run=data.get('run_id','')
            if str(UUID(run))!=run or data.get('parent_run_id')!=identity:raise GateError('OWNED_INTENT')
            journals+=original.evidence_bytes(ROOT/'.local/fix-live'/run)
        if journals>25165824:raise GateError('POSTTRADE_JOURNAL_BUDGET')
        return max(1,8388608-used)
    def run(args,label,cap=60):
        remaining=900-(time.monotonic()-started)
        if remaining<=0:raise GateError('POSTTRADE_GATE_DEADLINE')
        path=out/(label+'.log')
        run_bounded(args,path,min(cap,remaining),max_bytes=budget(),cwd=ROOT)
        return path
    def inputs():
        paths=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=ROOT).decode().split('\0')
        excluded={'artifacts','.local','node_modules','dist','playwright-report','test-results','demo-report','demo-results','.superpowers'}
        return input_identity(ROOT,[p for p in paths if p and Path(p).parts[0] not in excluded])
    def interrupted(unused_signal,unused_frame):
        if not cleaning:raise GateError('POSTTRADE_GATE_INTERRUPTED')
    for value in (signal.SIGINT,signal.SIGTERM):signal.signal(value,interrupted)
    try:
        if os.name!='posix':raise GateError('LINUX_OR_WSL_HOST_REQUIRED')
        contract=json.loads((ROOT/'contracts/posttrade-native-v1.json').read_text())
        if hashlib.sha256(json.dumps(contract,sort_keys=True,separators=(',',':')).encode()).hexdigest()!='6fb10108dd26f73203261e1b65387dd6ff22287cd0b133ee03a67d4866d6e98b':raise GateError('POSTTRADE_GATE_CONTRACT')
        live=json.loads((ROOT/'contracts/fix-live-application-v1.json').read_text())
        if hashlib.sha256(json.dumps(live,sort_keys=True,separators=(',',':')).encode()).hexdigest()!='3c5f7e28aedf220ee44be409864a2b58ca226097e62fe8e5a4787351c35e8deb':raise GateError('LIVE_GATE_CONTRACT')
        baseline=load_preservation(ROOT);verify_preserved(ROOT,baseline['files'])
        admit_pins(json.loads((ROOT/'tools/fix-session/dependencies.lock.json').read_text()),(ROOT/'tools/fix-session/Dockerfile').read_text())
        docker=require_tool('docker');node=require_tool('node')
        if not re.fullmatch(r'v24\.[0-9]+\.[0-9]+',run([node,'--version'],'node-version').read_text().strip()):raise GateError('NODE_VERSION')
        admit_control_receipt(run([sys.executable,'tools/fix-session/preservation_v3_controls.py'],'preservation-controls').read_text())
        before=inputs();write('source-inputs.json',before)
        report.update(source_revision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),source_inputs_sha256=hashlib.sha256((out/'source-inputs.json').read_bytes()).hexdigest(),preservation_contract_sha256=baseline['preservation_contract_sha256'],preserved_original_files=baseline['preserved_original_files'],reviewed_replacements=baseline['reviewed_replacements'])
        image_intended=True;write('image-intent.json',{'name':image,'run_id':identity,'scope':scope})
        run([docker,'build','--platform=linux/amd64','--progress=plain','--label','tradeflow.scope='+scope,'--label','tradeflow.run_id='+identity,'-f',str(ROOT/'tools/fix-session/Dockerfile'),'-t',image,str(ROOT)],'build',900)
        item=json.loads(run([docker,'image','inspect',image],'image-inspect').read_text())[0]
        runtime_image=item['Id']
        if not re.fullmatch(r'sha256:[a-f0-9]{64}',runtime_image) or item['Config']['Labels'].get('tradeflow.scope')!=scope or item['Config']['Labels'].get('tradeflow.run_id')!=identity:raise GateError('OWNED_IMAGE')
        report['runtime_image']=runtime_image
        os.environ.update(TF_FIX_LIVE_IMAGE=runtime_image,TF_LIVE_PARENT_RUN=identity,TF_LIVE_EVIDENCE_DIR=str(evidence),TF_LIVE_OWNER_POINTER=str(pointer),PYTHONDONTWRITEBYTECODE='1')
        log=run([node,'--import','tsx','--test','--test-concurrency=1','--test-reporter=tap','--test-timeout=60000','tests/posttrade-native/journey.test.ts'],'native-journey',900).read_text()
        counts={k:int(re.findall(r'^# '+k+r' ([0-9]+)$',log,re.MULTILINE)[-1]) for k in ('tests','pass','fail','cancelled','skipped','todo') if re.findall(r'^# '+k+r' ([0-9]+)$',log,re.MULTILINE)}
        if counts!={'tests':1,'pass':1,'fail':0,'cancelled':0,'skipped':0,'todo':0}:raise GateError('POSTTRADE_TEST_ADMISSION')
        matches=re.findall(r'POSTTRADE_NATIVE_RESULT ([^\n]+)',log)
        if len(matches)!=1:raise GateError('POSTTRADE_RECEIPT')
        receipt=json.loads(matches[0])
        if not(re.fullmatch('[a-f0-9]{64}',receipt.get('report_id','')) and receipt.get('native_apply_receipts')==5 and receipt.get('raw_executions')==3 and receipt.get('financial_commands')=='14' and receipt.get('financial_events')==22 and receipt.get('source_preserved') is True and receipt.get('external_delivery_verified') is False):raise GateError('POSTTRADE_RECEIPT')
        require_same_inputs(before,inputs());verify_preserved(ROOT,load_preservation(ROOT)['files']);budget()
        report.update(status='passed',tests=counts,journey=receipt)
    except BaseException as error:
        primary=str(error) if isinstance(error,GateError) else type(error).__name__;report['failure']=primary
    finally:
        cleaning=True;cleanup=[]
        def inspect(kind,name):
            value=subprocess.run([docker,'inspect',name] if kind=='container' else [docker,'image','inspect',name],capture_output=True,text=True,timeout=15,cwd=ROOT)
            if value.returncode==1 and ('No such' in value.stderr or 'no such' in value.stderr):return None
            if value.returncode:raise GateError('CLEANUP_INSPECTION')
            return json.loads(value.stdout)[0]
        def remove(kind,name,run,resource_scope,parent=None,expected_image=None):
            item=inspect(kind,name)
            if item is None:return
            labels=item['Config']['Labels']
            if labels.get('tradeflow.scope')!=resource_scope or labels.get('tradeflow.run_id')!=run:raise GateError('CLEANUP_OWNERSHIP')
            if parent and labels.get('tradeflow.parent_run_id')!=parent:raise GateError('CLEANUP_OWNERSHIP')
            if kind=='container' and (item['Name']!='/'+name or expected_image and item['Image']!=expected_image):raise GateError('CLEANUP_OWNERSHIP')
            subprocess.run([docker,'rm','--force',item['Id']] if kind=='container' else [docker,'image','rm',name],check=True,capture_output=True,text=True,timeout=30,cwd=ROOT)
            if inspect(kind,name) is not None:raise GateError('CLEANUP_STILL_PRESENT')
        if docker:
            for path in (evidence/'engine-intents').glob('*.json'):
                try:
                    intent=json.loads(path.read_text())
                    if intent['parent_run_id']!=identity or intent['image']!=runtime_image:raise GateError('CLEANUP_OWNERSHIP')
                    remove('container',intent['name'],intent['run_id'],intent['scope'],identity,runtime_image)
                except BaseException:cleanup.append('nested-runtime:'+path.stem)
            if image_intended:
                try:remove('image',image,identity,scope)
                except BaseException:cleanup.append('image')
        if node and pointer.exists():
            try:
                descriptor=pointer.read_text().strip()
                if descriptor and Path(descriptor).exists():
                    code="import {stopOwnedPostgres} from './scripts/owned-postgres.ts';await stopOwnedPostgres(process.argv[1],true);"
                    run_bounded([node,'--import','tsx','--input-type=module','-e',code,descriptor],out/'postgres-cleanup.log',30,max_bytes=65536,cwd=ROOT)
                    if Path(descriptor).exists():raise GateError('POSTGRES_CLEANUP')
            except BaseException:cleanup.append('postgres')
        try:budget()
        except BaseException:cleanup.append('evidence-budget')
        report.update(seconds=round(time.monotonic()-started,2),cleanup_unresolved=cleanup,owned_cleanup_complete=not cleanup)
        if cleanup:report['status']='failed'
        write('summary.json',report);print('Post-trade native evidence: '+str(out/'summary.json'),flush=True)
    if report['status']!='passed':raise GateError(primary or 'OWNED_CLEANUP_UNRESOLVED')
    print('Post-trade native journey:1/1; separate original43/89 and118/118 qualification still required',flush=True)

if __name__=='__main__':
    try:main()
    except GateError as error:sys.stderr.write('POSTTRADE_NATIVE_GATE_FAILED '+str(error)+'\n');raise SystemExit(1)
