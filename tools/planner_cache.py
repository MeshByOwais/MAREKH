"""Exact-request reuse for independently audited, unchanged local planning inputs."""
import hashlib
import json
import os
from pathlib import Path
import threading
import uuid


class PlanCache:
    def __init__(self, root):
        self.root=Path(root)
        self.directory=self.root/'data/work/dynamic/checked-cache'
        self.lock=threading.Lock()
        self.signature=None
        self.fingerprint=None

    def key(self, request):
        # Include actual terrain/crew assets, rules and implementation, not just
        # a dataset label. Rehash only when a file's identity/metadata changes.
        files=[]
        for folder in ('src','tools','config','public/sites'):
            files.extend(p for p in (self.root/folder).rglob('*')
                         if p.is_file() and '__pycache__' not in p.parts and p.suffix!='.pyc')
        files.sort()
        signature=[(str(p.relative_to(self.root)),p.stat().st_size,p.stat().st_mtime_ns,p.stat().st_ctime_ns) for p in files]
        dependencies=self.root/'data/work/global-python'
        dependency_stats=[(str(p.relative_to(dependencies)),p.stat().st_size,p.stat().st_mtime_ns,p.stat().st_ctime_ns)
                          for p in sorted(dependencies.rglob('*')) if p.is_file() and '__pycache__' not in p.parts and p.suffix!='.pyc']
        signature=(signature,dependency_stats,tuple(os.environ.get(k,'') for k in ('COLUMBIA_GDAL_PYTHON','MAREKH_BUN','PYTHONPATH')))
        with self.lock:
            if signature!=self.signature:
                digest=hashlib.sha256(b'marekh-exact-checked-cache-v1')
                for p in files:
                    digest.update(str(p.relative_to(self.root)).encode());digest.update(b'\0');digest.update(p.read_bytes())
                digest.update(json.dumps(signature[1:]).encode())
                self.fingerprint=digest.hexdigest();self.signature=signature
            # Normalize numeric equivalents (500 and 500.0) without rounding.
            normalized={**request,'roundTripBudgetM':float(request['roundTripBudgetM']),'gradeLimitDeg':float(request['gradeLimitDeg'])}
            return hashlib.sha256(json.dumps([self.fingerprint,normalized],sort_keys=True,separators=(',',':')).encode()).hexdigest()

    def get(self, key):
        try:
            record=json.loads((self.directory/f'{key}.json').read_text())
            result=record['result']
            checksum=hashlib.sha256(json.dumps(result,sort_keys=True,separators=(',',':')).encode()).hexdigest()
            if record['key']==key and record['checksum']==checksum and result.get('independentAudit') is True:
                return result
        except (OSError,ValueError,KeyError,TypeError,AttributeError):
            pass
        return None

    def put(self, key, result):
        if result.get('independentAudit') is not True:return
        self.directory.mkdir(parents=True,exist_ok=True)
        checksum=hashlib.sha256(json.dumps(result,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        temporary=self.directory/f'{key}.{uuid.uuid4().hex}.tmp'
        try:
            temporary.write_text(json.dumps(dict(key=key,checksum=checksum,result=result)))
            temporary.replace(self.directory/f'{key}.json')
        finally:
            temporary.unlink(missing_ok=True)
        # Bound disk use; older requests simply run normally again.
        for path in sorted(self.directory.glob('*.json'),key=lambda p:p.stat().st_mtime,reverse=True)[64:]:
            path.unlink(missing_ok=True)
