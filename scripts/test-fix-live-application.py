"""Mandatory owned schema9/native qualification. No hosted database or venue."""
import hashlib,json,os,re,signal,stat,subprocess,sys,threading,time
from pathlib import Path
from uuid import UUID,uuid4

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools/fix-session'))
from gate import GateError,admit_pins,admit_log_driver,require_tool,input_identity,require_same_inputs,verify_preserved,run_bounded

def readable(error):
    if not isinstance(error,FileNotFoundError):raise error
def evidence_path_error(root,path,info):
    error=GateError('EVIDENCE_PATH')
    error.evidence_path={'scan_root':str(root),'entry':str(path.relative_to(root)),'mode':oct(info.st_mode),'nlink':info.st_nlink,'size':info.st_size}
    return error

def evidence_bytes(path):
    result=0
    if not path.exists():return 0
    for base,dirs,files in os.walk(path,followlinks=False,onerror=readable):
        for name in dirs:
            p=Path(base)/name
            if p.is_symlink():raise evidence_path_error(path,p,p.lstat())
        for name in files:
            p=Path(base)/name
            try:info=p.lstat()
            except FileNotFoundError:continue
            if not stat.S_ISREG(info.st_mode):raise evidence_path_error(path,p,info)
            if info.st_nlink==0:
                # Lookup can hold a regular inode while owned cleanup unlinks it
                # before stat. It is already gone; charge its observed bytes
                # conservatively, just as ENOENT is an accepted removal race.
                result+=info.st_size
                continue
            if info.st_nlink!=1:raise evidence_path_error(path,p,info)
            result+=info.st_size
    return result

def main():
    identity=str(uuid4());scope='synthetic-fix-live-application';started=time.monotonic()
    out=ROOT/'artifacts'/('fix-live-application-'+identity);out.mkdir(parents=True,mode=0o700)
    private=ROOT/'.local'/'fix-live-gates'/identity
    for directory in [ROOT/'.local',ROOT/'.local'/'fix-live-gates',private]:directory.mkdir(exist_ok=True,mode=0o700)
    evidence=private/'cases';evidence.mkdir(mode=0o700)
    image='tradeflow-fix-live-application:run-'+identity;container='tradeflow-fix-live-application-'+identity
    intents={};groups={};pointers=[];cleaning=False;primary=None;docker=None;node=None;runtime_image=None
    report={'version':1,'run_id':identity,'profile':'fix-live-application-v1','physical_schema_revision':9,'scope':'SELECTED_LOCAL_SYNTHETIC_CASES','status':'failed','external_delivery_verified':False,'external_completeness_verified':False}
    def write(name,value):
        (out/name).write_text(json.dumps(value,sort_keys=True,indent=2)+'\n',encoding='utf8')
    write('owner.json',{'version':1,'run_id':identity,'scope':scope})
    def intend(kind,value):intents[kind]=value;write('ownership-intent.json',{'run_id':identity,'scope':scope,'resources':intents})
    def budget():
        used=evidence_bytes(out)+evidence_bytes(private)
        if used>8*1024*1024:raise GateError('LIVE_GATE_EVIDENCE_BUDGET')
        journals=0
        for path in (evidence/'engine-intents').glob('*.json'):
            intent=json.loads(path.read_text())
            run=intent.get('run_id','')
            if str(UUID(run))!=run or intent.get('parent_run_id')!=identity:raise GateError('OWNED_INTENT')
            journals+=evidence_bytes(ROOT/'.local/fix-live'/run)
        if journals>24*1024*1024:raise GateError('LIVE_GATE_JOURNAL_BUDGET')
        return max(1,8*1024*1024-used)
    def inputs():
        paths=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=ROOT).decode().split('\0')
        excluded={'artifacts','.local','node_modules','dist','playwright-report','test-results','demo-report','demo-results','.superpowers'}
        return input_identity(ROOT,[p for p in paths if p and Path(p).parts[0] not in excluded])
    def run(args,label,cap=60,managed=False):
        remaining=900-(time.monotonic()-started)
        if remaining<=0:raise GateError('LIVE_GATE_DEADLINE')
        path=out/(label+'.log');limit=budget()
        if not managed:run_bounded(args,path,min(cap,remaining),max_bytes=limit,cwd=ROOT);return path
        process=subprocess.Popen(args,cwd=ROOT,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,bufsize=0,start_new_session=True)
        failure=[];deadline=time.monotonic()+min(cap,remaining);finished=threading.Event()
        def stop():
            try:os.killpg(process.pid,signal.SIGKILL)
            except ProcessLookupError:pass
        with path.open('wb',buffering=0) as output:
            def copy():
                count=0
                try:
                    while not finished.is_set():
                        chunk=os.read(process.stdout.fileno(),8192)
                        if not chunk:return
                        output.write(chunk[:max(0,limit-count)]);count+=len(chunk)
                        if count>limit:failure.append('CHILD_OUTPUT_BUDGET');return
                except (OSError,ValueError):failure.append('CHILD_OUTPUT_IO')
            reader=threading.Thread(target=copy,daemon=True);reader.start()
            try:
                while process.poll() is None:
                    budget()
                    if failure:raise GateError(failure[0])
                    if time.monotonic()>=deadline:raise GateError('CHILD_DEADLINE')
                    threading.Event().wait(.05)
                reader.join(timeout=2)
                if reader.is_alive():raise GateError('CHILD_OUTPUT_SHUTDOWN')
                if failure:raise GateError(failure[0])
                if process.returncode!=0:raise GateError('CHILD_NONZERO')
                budget();return path
            finally:
                finished.set();stop();process.wait(timeout=5);reader.join(timeout=2);process.stdout.close()
    def interrupted(unused_signal,unused_frame):
        if not cleaning:raise GateError('LIVE_GATE_INTERRUPTED')
    for value in (signal.SIGINT,signal.SIGTERM):signal.signal(value,interrupted)
    try:
        if os.name!='posix':raise GateError('LINUX_OR_WSL_HOST_REQUIRED')
        docker=require_tool('docker');node=require_tool('node');python=require_tool('python3')
        contract=json.loads((ROOT/'contracts/fix-live-application-v1.json').read_text());expected=contract['required_groups']
        if hashlib.sha256(json.dumps(contract,sort_keys=True,separators=(',',':')).encode()).hexdigest()!='5bc70aadc14c2365dc70d9447861a04541ab94635975bc3de236bb7f33cd895c':raise GateError('LIVE_GATE_CONTRACT')
        if contract['required_controls']!=106 or sum(expected.values())!=106 or contract['gate_seconds']!=900:raise GateError('LIVE_GATE_CONTRACT')
        if contract['owned_budget']['aggregate_bytes']!=67108864:raise GateError('LIVE_GATE_CONTRACT')
        baseline=json.loads((ROOT/'tools/fix-session/preservation.json').read_text());verify_preserved(ROOT,baseline['files'])
        admit_pins(json.loads((ROOT/'tools/fix-session/dependencies.lock.json').read_text()),(ROOT/'tools/fix-session/Dockerfile').read_text())
        version=run([node,'--version'],'node-version').read_text().strip()
        if not re.fullmatch('v24\\.[0-9]+\\.[0-9]+',version):raise GateError('NODE_VERSION')
        before=inputs();write('source-inputs.json',before);report['source_inputs_sha256']=hashlib.sha256((out/'source-inputs.json').read_bytes()).hexdigest()
        report['private_evidence_directory']=str(private)
        report['source_revision']=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip();report['preserved_original_files']=len(baseline['files'])
        intend('image',image);print('Building the pinned live application runtime',flush=True)
        run([docker,'build','--platform=linux/amd64','--progress=plain','--label','tradeflow.scope='+scope,'--label','tradeflow.run_id='+identity,'-f',str(ROOT/'tools/fix-session/Dockerfile'),'-t',image,str(ROOT)],'build',900)
        program="import signal,unittest,json;signal.alarm(60);suite=unittest.defaultTestLoader.discover('tests/fix-live',pattern='test_*.py');r=unittest.TextTestRunner(verbosity=2).run(suite);print('LIVE_ENGINE_RESULT\\t'+json.dumps({'tests':r.testsRun,'successful':r.wasSuccessful(),'skipped':len(r.skipped)}),flush=True);raise SystemExit(not r.wasSuccessful() or r.testsRun!=21 or bool(r.skipped) or bool(r.expectedFailures) or bool(r.unexpectedSuccesses))"
        intend('container',container)
        cid=run([docker,'create','--name',container,'--label','tradeflow.scope='+scope,'--label','tradeflow.run_id='+identity,'--log-driver','none','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--cpus','1','--memory','1g','--memory-swap','1g','--pids-limit','128','--shm-size','64m','--tmpfs','/state:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000,mode=0700',image,'python','-c',program],'create').read_text().strip()
        if not re.fullmatch('[a-f0-9]{64}',cid):raise GateError('CONTAINER_ID')
        item=json.loads(run([docker,'inspect',cid],'runtime-inspect').read_text())[0];h=item['HostConfig'];cfg=item['Config'];admit_log_driver(h['LogConfig'])
        if not(h['NetworkMode']=='none' and not h['Binds'] and not h['PortBindings'] and h['ReadonlyRootfs'] and h['CapDrop']==['ALL'] and h['Memory']==1073741824 and h['MemorySwap']==1073741824 and h['NanoCpus']==1000000000 and h['PidsLimit']==128 and h['ShmSize']==67108864 and cfg['User']=='1000:1000' and cfg['Labels']['tradeflow.run_id']==identity and cfg['Labels']['tradeflow.scope']==scope and 'no-new-privileges' in h['SecurityOpt'] and set(h['Tmpfs'])=={'/state'} and 'size=64m' in h['Tmpfs']['/state'] and all(m['Type']!='bind' for m in item['Mounts'])):raise GateError('RUNTIME_ISOLATION')
        if any('DATABASE' in x.split('=',1)[0] or x.split('=',1)[0].startswith('PG') for x in cfg['Env']):raise GateError('RUNTIME_CREDENTIALS')
        runtime_image=item['Image'];report['runtime_image']=runtime_image
        print('Running21 bridge and actual engine controls',flush=True)
        log=run([docker,'start','--attach',cid],'engine',90)
        match=re.findall(r'LIVE_ENGINE_RESULT\t([^\n]+)',log.read_text())
        if len(match)!=1 or json.loads(match[0])!={'tests':21,'successful':True,'skipped':0}:raise GateError('ENGINE_RESULT')
        if run([docker,'inspect','--format','{{.State.ExitCode}}',cid],'engine-exit').read_text().strip()!='0':raise GateError('ENGINE_EXIT')
        groups['engine_bridge']=21
        program="import sys,unittest,json;sys.path.insert(0,'verification/python');suite=unittest.defaultTestLoader.discover('verification/python',pattern='test_fix_live_application.py');r=unittest.TextTestRunner(verbosity=2).run(suite);print('LIVE_ORACLE_RESULT\\t'+json.dumps({'tests':r.testsRun,'successful':r.wasSuccessful(),'skipped':len(r.skipped)}),flush=True);raise SystemExit(not r.wasSuccessful() or r.testsRun!=10 or bool(r.skipped) or bool(r.expectedFailures) or bool(r.unexpectedSuccesses))"
        log=run([python,'-c',program],'independent-python',30)
        match=re.findall(r'LIVE_ORACLE_RESULT\t([^\n]+)',log.read_text())
        if len(match)!=1 or json.loads(match[0])!={'tests':10,'successful':True,'skipped':0}:raise GateError('ORACLE_RESULT')
        groups['independent_python']=10
        program="import unittest,json;suite=unittest.defaultTestLoader.discover('verification/python',pattern='test_fix_live_gate_budget.py');r=unittest.TextTestRunner(verbosity=2).run(suite);print('LIVE_GATE_BUDGET_RESULT\\t'+json.dumps({'tests':r.testsRun,'successful':r.wasSuccessful(),'skipped':len(r.skipped)}),flush=True);raise SystemExit(not r.wasSuccessful() or r.testsRun!=5 or bool(r.skipped) or bool(r.expectedFailures) or bool(r.unexpectedSuccesses))"
        log=run([python,'-c',program],'host-budget-controls',30)
        match=re.findall(r'LIVE_GATE_BUDGET_RESULT\t([^\n]+)',log.read_text())
        if len(match)!=1 or json.loads(match[0])!={'tests':5,'successful':True,'skipped':0}:raise GateError('HOST_EVIDENCE_RESULT')
        groups['host_evidence']=5
        os.environ['PYTHONDONTWRITEBYTECODE']='1'
        os.environ['TF_FIX_LIVE_IMAGE']=runtime_image;os.environ['TF_LIVE_PARENT_RUN']=identity;os.environ['TF_LIVE_EVIDENCE_DIR']=str(evidence)
        cases=[('sql_admission','sql.test.ts',30),('controller','controller.test.ts',12),('independent_application','reconciliation.test.ts',14),('process_kill_recovery','recovery.test.ts',8),('lifecycle','lifecycle.test.ts',6)]
        for name,file,count in cases:
            pointer=out/(name+'-postgres-owner.txt');pointers.append(pointer);os.environ['TF_LIVE_OWNER_POINTER']=str(pointer)
            print('Running '+name+': '+str(count)+' controls',flush=True)
            log=run([node,'--import','tsx','--test','--test-reporter=tap','--test-timeout=60000','tests/fix-live/'+file],name,900,True)
            text=log.read_text();values={key:int(re.findall(r'^# '+key+r' ([0-9]+)$',text,re.MULTILINE)[-1]) for key in ('tests','pass','fail','cancelled','skipped','todo') if re.findall(r'^# '+key+r' ([0-9]+)$',text,re.MULTILINE)}
            if values!={'tests':count,'pass':count,'fail':0,'cancelled':0,'skipped':0,'todo':0}:raise GateError('LIVE_TEST_ADMISSION')
            groups[name]=count
        require_same_inputs(before,inputs());verify_preserved(ROOT,baseline['files']);budget()
        if groups!=expected:raise GateError('LIVE_GROUP_ADMISSION')
        report.update(status='passed',groups=groups,controls=sum(groups.values()),observed_financial_application_cases_passed=True)
    except BaseException as error:
        primary=str(error) if isinstance(error,GateError) else type(error).__name__;report['failure']=primary
        if hasattr(error,'evidence_path'):report['evidence_path_failure']=error.evidence_path
    finally:
        cleaning=True;cleanup=[]
        def inspect(kind,name):
            args=[docker,'inspect',name] if kind=='container' else [docker,'image','inspect',name]
            value=subprocess.run(args,capture_output=True,text=True,timeout=15,cwd=ROOT)
            if value.returncode==1 and ('No such' in value.stderr or 'no such' in value.stderr):return None
            if value.returncode:raise GateError('CLEANUP_INSPECTION')
            return json.loads(value.stdout)[0]
        def remove(name,run,resource_scope,kind,parent=None,expected_image=None):
            item=inspect(kind,name)
            if item is None:return
            labels=item['Config']['Labels']
            if labels.get('tradeflow.scope')!=resource_scope or labels.get('tradeflow.run_id')!=run:raise GateError('CLEANUP_OWNERSHIP')
            if parent and labels.get('tradeflow.parent_run_id')!=parent:raise GateError('CLEANUP_OWNERSHIP')
            if kind=='container' and(item['Name']!='/'+name or expected_image and item['Image']!=expected_image):raise GateError('CLEANUP_OWNERSHIP')
            args=[docker,'rm','--force',item['Id']] if kind=='container' else [docker,'image','rm',name]
            subprocess.run(args,check=True,capture_output=True,text=True,timeout=30,cwd=ROOT)
            if inspect(kind,name) is not None:raise GateError('CLEANUP_STILL_PRESENT')
        if docker:
            for path in (evidence/'engine-intents').glob('*.json'):
                try:
                    data=json.loads(path.read_text())
                    if data['parent_run_id']!=identity or data['image']!=runtime_image:raise GateError('CLEANUP_OWNERSHIP')
                    remove(data['name'],data['run_id'],data['scope'],'container',identity,runtime_image)
                except BaseException:cleanup.append('nested-runtime:'+path.stem)
            for kind in ('container','image'):
                if kind not in intents:continue
                try:remove(intents[kind],identity,scope,kind)
                except BaseException:cleanup.append(kind)
        if node:
            for pointer in pointers:
                try:
                    if not pointer.exists():continue
                    descriptor=pointer.read_text().strip()
                    if not descriptor:continue
                    if not Path(descriptor).exists():continue
                    code="import {stopOwnedPostgres} from './scripts/owned-postgres.ts';await stopOwnedPostgres(process.argv[1],true);"
                    run_bounded([node,'--import','tsx','--input-type=module','-e',code,descriptor],out/(pointer.stem+'-cleanup.log'),30,max_bytes=65536,cwd=ROOT)
                    if Path(descriptor).exists():raise GateError('POSTGRES_CLEANUP')
                except BaseException:cleanup.append('postgres:'+pointer.stem)
        report.update(groups=groups,seconds=round(time.monotonic()-started,2),cleanup_unresolved=cleanup,owned_cleanup_complete=not cleanup)
        if cleanup:report['status']='failed'
        write('summary.json',report);print('Live application evidence: '+str(out/'summary.json'),flush=True)
    if report['status']!='passed':raise GateError(primary or 'OWNED_CLEANUP_UNRESOLVED')
    print('Live application gate:106/106 controls; observed synthetic financial cases passed',flush=True)

if __name__=='__main__':
    try:main()
    except GateError as error:sys.stderr.write('FIX_LIVE_APPLICATION_GATE_FAILED '+str(error)+'\n');raise SystemExit(1)
