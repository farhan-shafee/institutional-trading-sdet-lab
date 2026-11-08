"""Fail-closed helpers shared by the portable host gate and matrix runner."""
import hashlib
import json
import os
import signal
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

class _WindowsJob:
    """Own a suspended child before it can create descendants (Windows 8+)."""
    def __init__(self):
        import ctypes
        from ctypes import wintypes as w
        self.ctypes=ctypes;self.handle=None
        self.api=ctypes.WinDLL('kernel32',use_last_error=True)
        size=ctypes.c_size_t;u64=ctypes.c_uint64
        class Basic(ctypes.Structure):
            _fields_=[('PerProcessUserTimeLimit',ctypes.c_int64),('PerJobUserTimeLimit',ctypes.c_int64),('LimitFlags',w.DWORD),('MinimumWorkingSetSize',size),('MaximumWorkingSetSize',size),('ActiveProcessLimit',w.DWORD),('Affinity',size),('PriorityClass',w.DWORD),('SchedulingClass',w.DWORD)]
        class Counters(ctypes.Structure):
            _fields_=[(name,u64) for name in ('ReadOperationCount','WriteOperationCount','OtherOperationCount','ReadTransferCount','WriteTransferCount','OtherTransferCount')]
        class Extended(ctypes.Structure):
            _fields_=[('BasicLimitInformation',Basic),('IoInfo',Counters),('ProcessMemoryLimit',size),('JobMemoryLimit',size),('PeakProcessMemoryUsed',size),('PeakJobMemoryUsed',size)]
        class ThreadEntry(ctypes.Structure):
            _fields_=[('dwSize',w.DWORD),('cntUsage',w.DWORD),('th32ThreadID',w.DWORD),('th32OwnerProcessID',w.DWORD),('tpBasePri',w.LONG),('tpDeltaPri',w.LONG),('dwFlags',w.DWORD)]
        self.ThreadEntry=ThreadEntry
        signatures={
            'CreateJobObjectW':([ctypes.c_void_p,w.LPCWSTR],w.HANDLE),
            'SetInformationJobObject':([w.HANDLE,ctypes.c_int,ctypes.c_void_p,w.DWORD],w.BOOL),
            'OpenProcess':([w.DWORD,w.BOOL,w.DWORD],w.HANDLE),
            'AssignProcessToJobObject':([w.HANDLE,w.HANDLE],w.BOOL),
            'CreateToolhelp32Snapshot':([w.DWORD,w.DWORD],w.HANDLE),
            'Thread32First':([w.HANDLE,ctypes.POINTER(ThreadEntry)],w.BOOL),
            'Thread32Next':([w.HANDLE,ctypes.POINTER(ThreadEntry)],w.BOOL),
            'OpenThread':([w.DWORD,w.BOOL,w.DWORD],w.HANDLE),
            'ResumeThread':([w.HANDLE],w.DWORD),
            'TerminateJobObject':([w.HANDLE,w.UINT],w.BOOL),
            'CloseHandle':([w.HANDLE],w.BOOL),
        }
        for name,(args,result) in signatures.items():
            function=getattr(self.api,name);function.argtypes=args;function.restype=result
        self.handle=self.api.CreateJobObjectW(None,None)
        try:
            if not self.handle:raise GateError('CHILD_OWNERSHIP')
            limits=Extended();limits.BasicLimitInformation.LimitFlags=0x2000 # KILL_ON_JOB_CLOSE
            if not self.api.SetInformationJobObject(self.handle,9,ctypes.byref(limits),ctypes.sizeof(limits)):raise GateError('CHILD_OWNERSHIP')
        except BaseException:self.close();raise

    def attach_and_resume(self,process):
        c=self.ctypes;a=self.api
        handle=a.OpenProcess(0x0101,False,process.pid) # SET_QUOTA | TERMINATE
        if not handle:raise GateError('CHILD_OWNERSHIP')
        try:
            if not a.AssignProcessToJobObject(self.handle,handle):raise GateError('CHILD_OWNERSHIP')
        finally:a.CloseHandle(handle)
        snapshot=a.CreateToolhelp32Snapshot(4,0) # TH32CS_SNAPTHREAD
        if snapshot in (None,c.c_void_p(-1).value):raise GateError('CHILD_OWNERSHIP')
        try:
            entry=self.ThreadEntry();entry.dwSize=c.sizeof(entry);found=a.Thread32First(snapshot,c.byref(entry))
            while found:
                if entry.th32OwnerProcessID==process.pid:
                    thread=a.OpenThread(2,False,entry.th32ThreadID) # SUSPEND_RESUME, our child only
                    if not thread:raise GateError('CHILD_OWNERSHIP')
                    try:
                        if a.ResumeThread(thread)!=1:raise GateError('CHILD_OWNERSHIP')
                    finally:a.CloseHandle(thread)
                    return
                entry.dwSize=c.sizeof(entry);found=a.Thread32Next(snapshot,c.byref(entry))
            raise GateError('CHILD_OWNERSHIP')
        finally:a.CloseHandle(snapshot)

    def terminate(self):
        if self.handle and not self.api.TerminateJobObject(self.handle,1):raise GateError('CHILD_TREE_CLEANUP')

    def close(self):
        if self.handle:self.api.CloseHandle(self.handle);self.handle=None

def run_bounded(args,path,timeout,max_bytes=64*1024*1024,cwd=None,stdin_path=None,show_progress=False):
    """Bound output and the whole owned CLI tree, including inherited pipes."""
    deadline=time.monotonic()+timeout;overflow=threading.Event();stopped=threading.Event();failure=[]
    source=Path(stdin_path).open('rb') if stdin_path else subprocess.DEVNULL
    process=None;reader=None;job=None
    def terminate():
        if job:job.terminate()
        elif process:
            try:os.killpg(process.pid,signal.SIGKILL)
            except ProcessLookupError:pass
    try:
        if os.name=='nt':job=_WindowsJob()
        options={'creationflags':4} if job else {'start_new_session':True}
        process=subprocess.Popen(args,cwd=cwd,stdin=source,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,bufsize=0,**options)
        if job:job.attach_and_resume(process)
        # Unbuffered handles do not take a buffered-reader lock during shutdown.
        with Path(path).open('wb',buffering=0) as out:
            def copy():
                count=0;pending=b'';completed=0
                try:
                    while not stopped.is_set():
                        data=os.read(process.stdout.fileno(),8192)
                        if not data or stopped.is_set():return
                        remaining=max_bytes-count
                        out.write(data[:max(0,remaining)]);count+=len(data)
                        if count>max_bytes:overflow.set();return
                        if show_progress:
                            lines=(pending+data).split(b'\n');pending=lines[-1][-1024:]
                            for line in lines[:-1]:
                                if line.startswith(b'CASE_END\t'):
                                    completed+=1
                                    if completed%10==0:print('Session controls completed: '+str(completed),flush=True)
                except (OSError,ValueError):failure.append('CHILD_OUTPUT_IO')
            reader=threading.Thread(target=copy,daemon=True);reader.start()
            reason=None
            while process.poll() is None:
                if overflow.is_set():reason='CHILD_OUTPUT_BUDGET';break
                if failure:reason=failure[0];break
                if time.monotonic()>=deadline:reason='CHILD_DEADLINE';break
                threading.Event().wait(.01)
            if reason is None:
                reader.join(timeout=min(2,max(0,deadline-time.monotonic())))
                if reader.is_alive():reason='CHILD_OUTPUT_SHUTDOWN'
            # Even a successful parent must not leave background descendants.
            terminate();process.wait(timeout=5);reader.join(timeout=2)
            if reader.is_alive() and reason is None:reason='CHILD_OUTPUT_SHUTDOWN'
            if reason:raise GateError(reason)
            if overflow.is_set():raise GateError('CHILD_OUTPUT_BUDGET')
            if failure:raise GateError(failure[0])
            if process.returncode!=0:raise GateError('CHILD_NONZERO')
            return {'exit_code':0,'bytes':Path(path).stat().st_size}
    finally:
        stopped.set()
        try:
            terminate()
            if process and process.poll() is None:process.kill();process.wait(timeout=5)
        finally:
            if reader:reader.join(timeout=2)
            if process and process.stdout:process.stdout.close()
            if job:job.close()
            if stdin_path:source.close()
