#!/usr/bin/env python3
"""Mandatory local synthetic session gate. No hosted service or financial SDK."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools/fix-session'))
from gate import GateError,admit_log_driver,admit_manifest,admit_pins,admit_results,input_identity,require_same_inputs,require_tool,run_bounded,verify_preserved
from preservation_v2 import load_preservation
from preflight import validate_reference

MAX_BYTES=67108864

def main():
    if sys.version_info<(3,12):raise GateError('PYTHON_VERSION')
    started=time.monotonic();identity=str(uuid4());out=ROOT/'artifacts'/('fix-session-'+identity)
    out.mkdir(parents=True,exist_ok=False)
    docker=None;container=None;image='tradeflow-fix-session:run-'+identity
    container_name='tradeflow-fix-session-'+identity;intents={}
    report={'run_id':identity,'scope':'synthetic-local-selected-session-profile','financial_application_verified':False,'status':'failed'}
    host_proofs={};peak_store=0
    def intend(kind,name):
        # Persist before the daemon request: a missing CLI receipt is uncertain.
        intents[kind]=name
        with (out/'ownership-intent.json').open('w',encoding='utf-8',newline='\n') as descriptor:
            json.dump({'version':1,'run_id':identity,'scope':'synthetic-fix-session','resources':intents},descriptor,sort_keys=True)
            descriptor.flush();os.fsync(descriptor.fileno())
    def remaining_bytes():
        used=sum(path.stat().st_size for path in out.rglob('*') if path.is_file())
        if used+peak_store>=MAX_BYTES:raise GateError('EVIDENCE_BUDGET')
        return MAX_BYTES-used-peak_store
    def run(args,name,cap=60,stdin_path=None):
        remaining=900-(time.monotonic()-started)
        if remaining<=0:raise GateError('GATE_DEADLINE')
        path=out/(name+'.log')
        run_bounded(args,path,min(cap,remaining),max_bytes=remaining_bytes(),cwd=ROOT,stdin_path=stdin_path,show_progress=name=='runtime')
        return path
    def source_inputs():
        paths=['package.json','package-lock.json','scripts/test-fix-session.py','scripts/test-fix-session.ts','scripts/verify-fix-session-compatibility.ts','contracts/fix-session-runtime-v1.json','verification/vendor/quickfix/FIX44.xml','tools/fix-session/Dockerfile','tools/fix-session/Dockerfile.dockerignore','tools/fix-session/dependencies.lock.json','tools/fix-session/preservation.json','tools/fix-session/preservation-v2.json','tools/fix-session/java/pom.xml','verification/fix-peer/go/go.mod','verification/fix-peer/go/go.sum']
        for pattern in ['tools/fix-session/*.py','tools/fix-session/runtime/*.py','tools/fix-session/calendar/*.go','tools/fix-session/java/src/**/*.java','verification/fix-peer/go/*.go','tests/fix-session/*.py','tests/preservation-v2/*.py','tests/fix-live/*.py','test-data/fix44/live/manifest.json','test-data/fix44/runtime/manifest.json','test-data/fix44/runtime/bindings.json']:
            paths.extend(p.relative_to(ROOT).as_posix() for p in ROOT.glob(pattern) if p.is_file())
        return input_identity(ROOT,paths)
    try:
        docker=require_tool('docker');node=require_tool('node')
        lock=json.loads((ROOT/'tools/fix-session/dependencies.lock.json').read_text())
        admit_pins(lock,(ROOT/'tools/fix-session/Dockerfile').read_text())
        manifest=json.loads((ROOT/'test-data/fix44/runtime/manifest.json').read_text())
        contract=json.loads((ROOT/'contracts/fix-session-runtime-v1.json').read_text())
        ids=admit_manifest(manifest,contract)
        bindings=json.loads((ROOT/'test-data/fix44/runtime/bindings.json').read_text())
        if set(bindings)!=set(ids):raise GateError('CASE_BINDINGS')
        baseline=load_preservation(ROOT)
        verify_preserved(ROOT,baseline['files']);host_proofs['host:preservation']='passed'
        for name,key in [('go.mod','go_mod_sha256'),('go.sum','go_sum_sha256')]:
            if hashlib.sha256((ROOT/'verification/fix-peer/go'/name).read_bytes()).hexdigest()!=lock[key]:raise GateError('GO_INPUT_HASH')
        versions=run([node,'--version'],'node-version').read_text().strip()
        if not re.fullmatch(r'v24\.\d+\.\d+',versions):raise GateError('NODE_VERSION')
        references=[]
        cache=os.environ.get('TRADEFLOW_FIX_REFERENCE_DIR')
        for index,reference in enumerate(lock['references']):
            if cache:
                with (Path(cache)/(reference['sha256']+'.pdf')).open('rb') as source:payload=source.read(16*1024*1024+1)
                validate_reference(200,'application/pdf',payload,reference['sha256'],'pdf')
                origin='hash-verified-local-cache'
                if len(payload)!=reference['bytes']:raise GateError('REFERENCE_SIZE')
                path=out/('reference-'+str(index)+'.pdf');path.write_bytes(payload)
            else:
                origin='frozen-authoring-provenance-not-refetched'
            references.append({'sha256':reference['sha256'],'bytes':reference['bytes'],'origin':origin})
            remaining_bytes()
        report['references']=references
        run([docker,'version','--format','{{json .Server}}'],'docker-version')
        inputs=source_inputs();encoded=json.dumps(inputs,sort_keys=True,indent=2)+'\n'
        (out/'build-inputs.json').write_text(encoded,encoding='utf-8',newline='\n')
        report['build_inputs_sha256']=hashlib.sha256(encoded.encode()).hexdigest()
        report['preserved_original_files']=baseline['preserved_original_files'];report['reviewed_replacements']=baseline['reviewed_replacements'];report['preservation_version']=baseline['version'];report['preservation_contract_sha256']=baseline['preservation_contract_sha256']
        run([sys.executable,'-m','unittest','discover','-s','tests/preservation-v2','-p','test_*.py','-v'],'preservation-v2-controls')
        print('Building pinned session peers',flush=True)
        intend('image',image)
        run([docker,'build','--platform=linux/amd64','--progress=plain','--label','tradeflow.scope=synthetic-fix-session','--label','tradeflow.run_id='+identity,'-f',str(ROOT/'tools/fix-session/Dockerfile'),'-t',image,str(ROOT)],'build',cap=900)
        args=[docker,'create','--name',container_name,'--label','tradeflow.scope=synthetic-fix-session','--label','tradeflow.run_id='+identity,'--log-driver','none','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--cpus','1','--memory','1g','--memory-swap','1g','--pids-limit','128','--shm-size','64m','--tmpfs','/state:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000,mode=0700',image,'python','tools/fix-session/run_matrix.py']
        intend('container',container_name)
        container=run(args,'create').read_text().strip()
        if not re.fullmatch(r'[a-f0-9]{64}',container):raise GateError('CONTAINER_ID')
        inspected=json.loads(run([docker,'inspect',container],'runtime-inspect').read_text())[0]
        h=inspected['HostConfig'];cfg=inspected['Config']
        admit_log_driver(h['LogConfig'])
        if not (h['NetworkMode']=='none' and not h['PortBindings'] and not h['Binds'] and h['ReadonlyRootfs'] and h['CapDrop']==['ALL'] and h['Memory']==1073741824 and h['MemorySwap']==1073741824 and h['NanoCpus']==1000000000 and h['PidsLimit']==128 and h['ShmSize']==67108864 and cfg['User']=='1000:1000' and cfg['Labels']['tradeflow.run_id']==identity and 'no-new-privileges' in h['SecurityOpt'] and set(h['Tmpfs'])=={'/state'} and 'size=64m' in h['Tmpfs']['/state']):raise GateError('RUNTIME_ISOLATION')
        if any(mount.get('Type')=='bind' for mount in inspected['Mounts']):raise GateError('RUNTIME_ISOLATION')
        host_proofs['host:runtime_namespace']='passed';report['runtime_image']=inspected['Image']
        print('Running complete session matrix',flush=True)
        # Attach before start: preserve first output while disabling daemon disk logs.
        logs=run([docker,'start','--attach',container],'runtime',cap=900)
        code=run([docker,'inspect','--format','{{.State.ExitCode}}',container],'exit-code').read_text().strip()
        if code!='0':raise GateError('RUNTIME_NONZERO')
        matrices=[];receipts=[]
        for line in logs.read_text().splitlines():
            if line.startswith('MATRIX_RESULT\t'):matrices.append(json.loads(line.split('\t',1)[1]))
            if line.startswith('LAB_RECEIPT\t'):receipts.append(json.loads(line.split('\t',1)[1]))
        if len(matrices)!=1 or not receipts:raise GateError('RUNTIME_EVIDENCE')
        matrix=matrices[0]
        if matrix['successful'] is not True or matrix['tests_run']!=len(matrix['discovered']):raise GateError('CASE_RESULT')
        if any(receipt['financial_application_verified'] is not False or receipt['external_delivery_verified'] is not False for receipt in receipts):raise GateError('FINANCIAL_SCOPE')
        complete=[receipt for receipt in receipts if receipt['transport_evidence_complete']]
        if not complete:raise GateError('RUNTIME_EVIDENCE')
        peak_store=max(receipt['owned_state_bytes'] for receipt in complete)
        remaining_bytes()
        frames={}
        for receipt in receipts:
            if not receipt['transport_evidence_complete']:continue
            for frame in receipt['wire']:
                kind=frame['fields']['35']
                if frame['stage']=='sender_observed' and kind in ('D','8','F','9') and kind not in frames:frames[kind]=frame
        if set(frames)!={'D','8','F','9'}:raise GateError('COMPATIBILITY_DISCOVERY')
        captured=out/'current-captured-frames.json';captured.write_text(json.dumps(list(frames.values()),indent=2)+'\n')
        compatibility=json.loads(run([node,'--import','tsx','scripts/verify-fix-session-compatibility.ts'],'compatibility',stdin_path=captured).read_text())
        if compatibility['financial_application_verified'] is not False or compatibility['wire_normalized'] is not False or {entry['type'] for entry in compatibility['results']}!={'D','8','F','9'}:raise GateError('COMPATIBILITY_SCOPE')
        host_proofs['host:current_compatibility']='passed'
        discovered=matrix['discovered']+list(host_proofs);outcomes={**matrix['outcomes'],**host_proofs}
        passed=admit_results(bindings,discovered,outcomes)
        verify_preserved(ROOT,load_preservation(ROOT)['files'])
        require_same_inputs(inputs,source_inputs())
        report.update(status='passed',cases=passed,tests_run=matrix['tests_run'],compatibility=compatibility,negative_receipts=sum(not r['transport_evidence_complete'] for r in receipts),elapsed_seconds=round(time.monotonic()-started,3))
        print(f"Session matrix: {len(passed)}/43 cases; {matrix['tests_run']} controls passed",flush=True)
    except BaseException as error:
        report['error']=str(error) if isinstance(error,GateError) else type(error).__name__
        raise
    finally:
        cleanup=[];removed={};cleanup_deadline=time.monotonic()+30
        active_error=sys.exc_info()[0] is not None
        def cleanup_run(args,name):
            remaining=cleanup_deadline-time.monotonic()
            if remaining<=0:raise GateError('CLEANUP_DEADLINE')
            path=out/(name+'.log')
            run_bounded(args,path,min(15,remaining),max_bytes=32768,cwd=ROOT)
            return path
        for kind in ('container','image'):
            if kind not in intents:continue
            try:
                args=[docker,'inspect',intents[kind]] if kind=='container' else [docker,'image','inspect',intents[kind]]
                result=json.loads(cleanup_run(args,kind+'-cleanup-inspect').read_text())
                if len(result)!=1:raise GateError('CLEANUP_IDENTITY')
                item=result[0];labels=item['Config']['Labels'];resource_id=item['Id']
                pattern=r'[a-f0-9]{64}' if kind=='container' else r'sha256:[a-f0-9]{64}'
                if not re.fullmatch(pattern,resource_id) or labels.get('tradeflow.scope')!='synthetic-fix-session' or labels.get('tradeflow.run_id')!=identity:raise GateError('CLEANUP_OWNERSHIP')
                if kind=='container' and item['Name']!='/'+container_name:raise GateError('CLEANUP_OWNERSHIP')
                args=[docker,'rm','-f',resource_id] if kind=='container' else [docker,'image','rm',resource_id]
                cleanup_run(args,kind+'-cleanup');removed[kind]=resource_id
            except BaseException:cleanup.append(kind.upper()+'_CLEANUP_UNRESOLVED')
        report.update(ownership_intents=intents,removed_owned_resources=removed,owned_cleanup_complete=not cleanup)
        if cleanup:report.update(status='failed',cleanup_errors=cleanup)
        (out/'summary.json').write_text(json.dumps(report,indent=2)+'\n')
        print('Evidence: '+str(out/'summary.json'),flush=True)
        if cleanup and not active_error:raise GateError(cleanup[0])

if __name__=='__main__':
    try:main()
    except BaseException as error:
        print('FIX_SESSION_GATE_FAILED '+(str(error) if isinstance(error,GateError) else type(error).__name__),file=sys.stderr)
        raise SystemExit(1)
