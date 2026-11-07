"""Fail-closed helpers shared by the portable host gate and matrix runner."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time

class GateError(RuntimeError):pass

def admit_log_driver(value):
    if value!={'Type':'none','Config':{}}:raise GateError('RUNTIME_LOG_BUDGET')

def require_tool(name):
    path=shutil.which(name)
    if path is None:raise GateError('MISSING_TOOL')
    return path

def admit_manifest(manifest,contract):
    expected={f'S{family:02d}-{index:02d}' for family,count in enumerate([2,5,4,1,1,2,2,5,5,3,4,3,4,1,1],1) for index in range(1,count+1)}
    cases=manifest.get('cases',[])
    if len(cases)!=43 or {c.get('id') for c in cases}!=expected or set(contract.get('required_case_ids',[]))!=expected:raise GateError('CASE_MANIFEST')
    if any(not c.get('expected') or not c.get('test_case_sections') or not c.get('boundary') for c in cases):raise GateError('CASE_EXPECTATION')
    if manifest.get('financial_application_verified') is not False or contract.get('financial_application_verified') is not False:raise GateError('CASE_SCOPE')
    # Freeze authored metadata semantics; whitespace formatting is not wire rewriting.
    if hashlib.sha256(json.dumps(manifest,sort_keys=True,separators=(',',':')).encode()).hexdigest()!='b1fc19ab42ca7257024d142408f9b0aec520162c24a388a8580482ab6c2a5c48':raise GateError('CASE_EXPECTATION')
    if hashlib.sha256(json.dumps(contract,sort_keys=True,separators=(',',':')).encode()).hexdigest()!='bd9c00cdd29f41fcbb63b90fb1335d778257ad8c4742fa58f38ddb4eb26d763d':raise GateError('CASE_PROFILE')
    return sorted(expected)

def admit_pins(lock,dockerfile):
    try:
        if lock['version']!=1 or lock['engine_versions']!={'quickfixj':'3.0.2','quickfixgo':'v0.9.12'}:raise ValueError()
        images=lock['images'];actual=re.findall(r'^FROM (\S+)',dockerfile,re.MULTILINE)
        if len(images)!=4 or set(actual)!={v['tag']+'@'+v['digest'] for v in images.values()}:raise ValueError()
        for value in images.values():
            if not re.fullmatch(r'sha256:[a-f0-9]{64}',value['digest']):raise ValueError()
        if len(lock['java_artifacts'])!=7 or len(lock['references'])!=2:raise ValueError()
        if {(ref['sha256'],ref['bytes']) for ref in lock['references']}!={('526e60993fce12bddb02add00db43eb762dbf618fad60886f78c33c766e26aa9',1852710),('f08ca0ddcf516f8ac0ba2715077f8d22ee1729d899c9c07563d19845c4b0ba6e',403523)}:raise ValueError()
        for artifact in lock['java_artifacts']+lock['references']:
            if not re.fullmatch(r'[a-f0-9]{64}',artifact['sha256']) or artifact['bytes']<=0:raise ValueError()
        for key in ('go_mod_sha256','go_sum_sha256'):
            if not re.fullmatch(r'[a-f0-9]{64}',lock[key]):raise ValueError()
    except (KeyError,TypeError,ValueError):raise GateError('PIN_IDENTITY') from None

def verify_preserved(root,files):
    if not files:raise GateError('SOURCE_PRESERVATION')
    for name,digest in files.items():
        path=Path(name)
        if path.is_absolute() or '..' in path.parts:raise GateError('SOURCE_PRESERVATION')
        try:actual=hashlib.sha256((root/path).read_bytes()).hexdigest()
        except OSError:raise GateError('SOURCE_PRESERVATION') from None
        if actual!=digest:raise GateError('SOURCE_PRESERVATION')

def input_identity(root,paths):
    if not paths:raise GateError('INPUT_PATHS')
    result={}
    for name in sorted(set(paths)):
        path=Path(name)
        if path.is_absolute() or '..' in path.parts or (root/path).is_symlink():raise GateError('INPUT_PATHS')
        try:
            if (root/path).stat().st_size>16*1024*1024:raise GateError('INPUT_PATHS')
            result[name]=hashlib.sha256((root/path).read_bytes()).hexdigest()
        except OSError:raise GateError('INPUT_PATHS') from None
    return result

def require_same_inputs(before,after):
    if not before or before!=after:raise GateError('SOURCE_CHANGED_DURING_GATE')

def admit_results(bindings,discovered,outcomes):
    if not bindings or not discovered or len(discovered)!=len(set(discovered)):raise GateError('CASE_DISCOVERY')
    for names in bindings.values():
        if not names or any(name not in discovered for name in names):raise GateError('CASE_DISCOVERY')
        if any(outcomes.get(name)!='passed' for name in names):raise GateError('CASE_RESULT')
    if any(outcomes.get(name)!='passed' for name in discovered):raise GateError('CASE_RESULT')
    return sorted(bindings)

def run_bounded(args,path,timeout,max_bytes=64*1024*1024,cwd=None,stdin_path=None,show_progress=False):
    """Bound bytes, wall clock and the owned CLI; retain the first failed output."""
    deadline=time.monotonic()+timeout;overflow=threading.Event();failure=[]
    source=Path(stdin_path).open('rb') if stdin_path else subprocess.DEVNULL
    try:
        process=subprocess.Popen(args,cwd=cwd,stdin=source,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    except BaseException:
        if stdin_path:source.close()
        raise
    try:
        with Path(path).open('wb') as out:
            def copy():
                count=0;pending=b'';completed=0
                try:
                    while True:
                        data=process.stdout.read1(8192)
                        if not data:return
                        remaining=max_bytes-count
                        out.write(data[:max(0,remaining)]);out.flush();count+=len(data)
                        if count>max_bytes:overflow.set();return
                        if show_progress:
                            lines=(pending+data).split(b'\n');pending=lines[-1][-1024:]
                            for line in lines[:-1]:
                                if line.startswith(b'CASE_END\t'):
                                    completed+=1
                                    if completed%10==0:print('Session controls completed: '+str(completed),flush=True)
                except OSError:failure.append('CHILD_OUTPUT_IO')
            reader=threading.Thread(target=copy,daemon=True);reader.start()
            reason=None
            while process.poll() is None:
                if overflow.is_set():reason='CHILD_OUTPUT_BUDGET';break
                if time.monotonic()>=deadline:reason='CHILD_DEADLINE';break
                threading.Event().wait(.01)
            if reason is not None:process.kill()
            process.wait(timeout=5);reader.join(timeout=2)
            if reader.is_alive():raise GateError('CHILD_OUTPUT_SHUTDOWN')
            if overflow.is_set():raise GateError('CHILD_OUTPUT_BUDGET')
            if reason:raise GateError(reason)
            if failure:raise GateError(failure[0])
            if process.returncode!=0:raise GateError('CHILD_NONZERO')
            return {'exit_code':0,'bytes':Path(path).stat().st_size}
    finally:
        if process.poll() is None:process.kill();process.wait(timeout=5)
        process.stdout.close()
        if stdin_path:source.close()
