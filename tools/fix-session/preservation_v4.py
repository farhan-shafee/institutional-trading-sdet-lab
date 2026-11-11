"""Exactly18 reviewed public Phase4 replacements over immutable v1/v2/v3."""
from pathlib import Path
import re
import stat

from gate import GateError, verify_preserved as verify_original, input_identity as original_identity
from preservation_v2 import _metadata
from preservation_v3 import load_preservation as load_v3

CONTRACT_SHA256 = 'fa6482ffc5d171a0cb22590ae220e9509a69c92f0fceea24863d85b7f4e7b2f5'
PRIOR_CONTRACT_SHA256 = '2950d631d256e715935938bbc253af92aaa565537a48e79bcadf7630037d00ab'
BASELINE_SHA256 = 'd75f72090bafb12f51990bbe8e95aaba5a72c014fed291a3a8199c2303fc5f07'
APPROVED_PATHS = frozenset(['README.md', 'app/domain/workflow/reconciliation.ts', 'app/public/fixed-income.ts', 'app/public/index.html', 'app/public/rfq.ts', 'app/public/style.css', 'app/server/configuration.ts', 'app/server/fixed-income-workflow/routes.ts', 'app/server/index.ts', 'app/server/public-demo/configuration.ts', 'app/server/public-demo/maintenance.ts', 'app/server/public-demo/profile.ts', 'app/server/public-demo/workspaces.ts', 'app/server/reconciliation/database.ts', 'app/server/reconciliation/manifest.ts', 'app/server/reconciliation/runner.ts', 'app/server/reconciliation/service.ts', 'contracts/openapi.yaml'])
FIXTURE = 'tools/fix-session/preservation-v3-source.zip'

def regular_path(root, name):
    """Reject redirected parents as well as leaf symlinks, before opening."""
    path = Path(name)
    if path.is_absolute() or '..' in path.parts or path.as_posix() != name:
        raise GateError('SOURCE_PRESERVATION')
    for parent in [path, *path.parents]:
        if (root / parent).is_symlink():
            raise GateError('SOURCE_PRESERVATION')
    actual = root / path
    if not stat.S_ISREG(actual.stat().st_mode):
        raise GateError('SOURCE_PRESERVATION')
    return actual

def verify_preserved(root, files):
    try:
        for name in files:
            regular_path(Path(root), name)
        verify_original(Path(root), files)
    except OSError:
        raise GateError('SOURCE_PRESERVATION') from None

def input_identity(root, paths):
    try:
        for name in paths:
            regular_path(Path(root), name)
        return original_identity(Path(root), paths)
    except (OSError, GateError):
        raise GateError('INPUT_PATHS') from None

def load_preservation(root):
    """No optional metadata, live hash inference, fixture source or fallback."""
    try:
        root = Path(root)
        for name in ('preservation.json', 'preservation-v2.json',
                     'preservation-v3.json', 'preservation-v4.json'):
            regular_path(root, 'tools/fix-session/' + name)
        contract = _metadata(root, 'tools/fix-session/preservation-v4.json', CONTRACT_SHA256)
        if (set(contract) != {'version', 'scope', 'approved_source_commit',
                'approved_specification', 'baseline_sha256', 'prior_contract_sha256',
                'replacements', 'historical_v3_fixture', 'historical_control_files'} or
                type(contract['version']) is not int or contract['version'] != 4 or
                contract['scope'] != 'public-phase4-source-exceptions-v1' or
                contract['approved_source_commit'] != '379af5cd99f8c519976e31dd4863cfbf8c264b6e' or
                contract['baseline_sha256'] != BASELINE_SHA256 or
                contract['prior_contract_sha256'] != PRIOR_CONTRACT_SHA256 or
                set(contract['replacements']) != APPROVED_PATHS or
                set(contract['historical_v3_fixture']) != {'file', 'sha256', 'files'} or
                contract['historical_v3_fixture']['file'] != FIXTURE):
            raise GateError('SOURCE_PRESERVATION')
        prior = load_v3(root)
        if prior['preservation_contract_sha256'] != PRIOR_CONTRACT_SHA256:
            raise GateError('SOURCE_PRESERVATION')
        files = dict(prior['files'])
        for name, replacement in contract['replacements'].items():
            if (set(replacement) != {'approved_sha256', 'sha256'} or
                    files.get(name) != replacement['approved_sha256'] or
                    not isinstance(replacement['sha256'], str) or
                    not re.fullmatch(r'[0-9a-f]{64}', replacement['sha256'])):
                raise GateError('SOURCE_PRESERVATION')
            files[name] = replacement['sha256']
        return dict(prior, version=4, files=files, preserved_original_files=415,
                    reviewed_replacements=19, layer_replacements=18,
                    preservation_contract_sha256=CONTRACT_SHA256,
                    prior_preservation_contract_sha256=PRIOR_CONTRACT_SHA256,
                    historical_v3_fixture=contract['historical_v3_fixture'],
                    historical_control_files=contract['historical_control_files'])
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        raise GateError('SOURCE_PRESERVATION') from None
