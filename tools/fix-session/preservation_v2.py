"""Owner-approved Phase4A exact replacements; the historical verifier stays strict."""
import hashlib
import json
from pathlib import Path
import re
import stat

from gate import GateError

CONTRACT_SHA256 = 'd9bc9d63bdf286952fb009a4d478a3d714678705ceec03b15741ad73783649e9'
BASELINE_SHA256 = 'd75f72090bafb12f51990bbe8e95aaba5a72c014fed291a3a8199c2303fc5f07'
APPROVED_PATHS = frozenset({'app/server/fixed-income.ts', 'contracts/openapi.yaml'})

def _metadata(root, name, digest):
    path = root / name
    if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode):
        raise GateError('SOURCE_PRESERVATION')
    with path.open('rb') as descriptor:
        raw = descriptor.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024 or hashlib.sha256(raw).hexdigest() != digest:
        raise GateError('SOURCE_PRESERVATION')
    return json.loads(raw)

def load_preservation(root):
    """Never infer approved hashes from current files or fall back to an older map."""
    try:
        root = Path(root)
        contract = _metadata(root, 'tools/fix-session/preservation-v2.json', CONTRACT_SHA256)
        if (contract['version'] != 2 or
                contract['scope'] != 'phase4a-zero-coupon-read-api-v1' or
                contract['approved_source_commit'] != '6bb7741a8664ccd5ae0f078dc86423dfe3eb25bd' or
                contract['baseline_sha256'] != BASELINE_SHA256 or
                set(contract['replacements']) != APPROVED_PATHS):
            raise GateError('SOURCE_PRESERVATION')
        baseline = _metadata(root, 'tools/fix-session/preservation.json', BASELINE_SHA256)
        if baseline['version'] != 1 or len(baseline['files']) != 434:
            raise GateError('SOURCE_PRESERVATION')
        files = dict(baseline['files'])
        for name, replacement in contract['replacements'].items():
            if (set(replacement) != {'original_sha256', 'sha256'} or
                    files.get(name) != replacement['original_sha256'] or
                    not re.fullmatch(r'[0-9a-f]{64}', replacement['sha256'])):
                raise GateError('SOURCE_PRESERVATION')
            files[name] = replacement['sha256']
        return dict(baseline, version=2, files=files,
                    preserved_original_files=len(files) - len(APPROVED_PATHS),
                    reviewed_replacements=len(APPROVED_PATHS),
                    preservation_contract_sha256=CONTRACT_SHA256)
    except (OSError, ValueError, KeyError, TypeError):
        raise GateError('SOURCE_PRESERVATION') from None
