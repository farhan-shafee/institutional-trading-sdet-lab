"""One owned local run; never replace a missing/corrupt engine store with an empty one."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
from uuid import UUID

MAX_STORE_BYTES=64*1024*1024
class OwnershipError(ValueError):pass

def check_configuration(host,acceptor_port,proxy_port,resets):
    if host!='127.0.0.1' or acceptor_port!=19876 or proxy_port!=19875 or resets is not False:
        raise OwnershipError('LOCAL_PROFILE_REQUIRED')

def _regular(path):
    info=path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:raise OwnershipError('STORE_FILE_TYPE')
    return info

def _directories(path):
    for p in [path,*path.parents]:
        if p.exists() and (p.is_symlink() or not p.is_dir()):raise OwnershipError('STORE_PATH')

def _read_json(path):
    if _regular(path).st_size>8192:raise OwnershipError('STORE_METADATA_SIZE')
    try:return json.loads(path.read_text(encoding='utf-8'))
    except (ValueError,OSError):raise OwnershipError('STORE_METADATA') from None

class StoreOwner:
    def __init__(self,root,identity):
        self.root=Path(root)
        try:
            if not self.root.is_absolute() or str(UUID(identity))!=identity:raise ValueError()
        except (ValueError,TypeError,AttributeError):raise OwnershipError('RUN_IDENTITY') from None
        self.identity=identity;self.lock=None;self.reopened=False

    def __enter__(self):
        _directories(self.root)
        self.root.mkdir(mode=0o700,parents=True,exist_ok=True)
        path=self.root/'.run.lock'
        if path.exists():_regular(path)
        fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        self.lock=fd
        try:
            try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:raise OwnershipError('RUN_ALREADY_OWNED') from None
            identity=self.root/'.owner.json'
            expected={'version':1,'run_id':self.identity,'sender':'TRADEFLOW','target':'ATLAS'}
            self.reopened=identity.exists()
            if identity.exists():
                if _read_json(identity)!=expected:raise OwnershipError('RUN_IDENTITY')
            else:
                if any(p.name!='.run.lock' for p in self.root.iterdir()):raise OwnershipError('RUN_UNOWNED')
                with identity.open('x',encoding='utf-8') as out:
                    json.dump(expected,out,sort_keys=True);out.flush();os.fsync(out.fileno())
            return self
        except BaseException:
            os.close(fd);self.lock=None;raise

    def __exit__(self,*unused):
        if self.lock is not None:
            os.close(self.lock);self.lock=None

    def budget(self):
        total=0
        def unreadable(unused):raise OwnershipError('STORE_UNREADABLE') from None
        for parent,dirs,files in os.walk(self.root,followlinks=False,onerror=unreadable):
            for d in dirs:
                if (Path(parent)/d).is_symlink():raise OwnershipError('STORE_PATH')
            for name in files:
                total+=_regular(Path(parent)/name).st_size
                if total>MAX_STORE_BYTES:raise OwnershipError('STORE_BUDGET')
        return total

    def inventory(self,role):
        if role not in ('java','go'):raise OwnershipError('STORE_ROLE')
        self.budget();root=self.root/role;_directories(root)
        if not root.is_dir():raise OwnershipError('STORE_MISSING')
        result={}
        for path in sorted(root.iterdir()):
            info=_regular(path)
            with path.open('rb') as f:
                digest=hashlib.file_digest(f,'sha256').hexdigest()
            result[path.name]={'bytes':info.st_size,'sha256':digest}
        if not result:raise OwnershipError('STORE_MISSING')
        return result

    def checkpoint(self,role):
        result=self.inventory(role)
        payload={'version':1,'run_id':self.identity,'role':role,'files':result}
        temp=self.root/('.checkpoint-'+role+'.tmp')
        with temp.open('x',encoding='utf-8') as out:
            json.dump(payload,out,sort_keys=True);out.flush();os.fsync(out.fileno())
        os.replace(temp,self.root/('.checkpoint-'+role+'.json'))
        return result

    def verify(self,role):
        current=self.inventory(role)
        path=self.root/('.checkpoint-'+role+'.json')
        if not path.exists():raise OwnershipError('STORE_CHECKPOINT_MISSING')
        expected={'version':1,'run_id':self.identity,'role':role,'files':current}
        if _read_json(path)!=expected:raise OwnershipError('STORE_CHANGED_OR_UNCERTAIN')
        return current
