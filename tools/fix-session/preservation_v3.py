"""Exactly three owner-approved changes layered over immutable v1/v2 contracts."""
from pathlib import Path
import re

from gate import GateError
from preservation_v2 import _metadata, load_preservation as load_v2

CONTRACT_SHA256 = '2950d631d256e715935938bbc253af92aaa565537a48e79bcadf7630037d00ab'
PRIOR_CONTRACT_SHA256 = 'd9bc9d63bdf286952fb009a4d478a3d714678705ceec03b15741ad73783649e9'
BASELINE_SHA256 = 'd75f72090bafb12f51990bbe8e95aaba5a72c014fed291a3a8199c2303fc5f07'
APPROVED_PATHS = frozenset({
    'app/server/fixed-income-workflow/routes.ts',
    'app/server/fixed-income.ts',
    'contracts/openapi.yaml',
})
FIXTURE = 'tools/fix-session/preservation-v2-source.zip'

def load_preservation(root):
    """No live-file hash inference, optional contract, or prior-version fallback."""
    try:
        root = Path(root)
        contract = _metadata(root, 'tools/fix-session/preservation-v3.json', CONTRACT_SHA256)
        if (contract['version'] != 3 or
                contract['scope'] != 'phase4-posttrade-source-exceptions-v1' or
                contract['approved_source_commit'] != 'b875714bd50bfe1c12ac4254372c681fe122dd6f' or
                contract['baseline_sha256'] != BASELINE_SHA256 or
                contract['prior_contract_sha256'] != PRIOR_CONTRACT_SHA256 or
                set(contract['replacements']) != APPROVED_PATHS or
                contract['historical_v2_fixture']['file'] != FIXTURE):
            raise GateError('SOURCE_PRESERVATION')
        prior = load_v2(root)
        if prior['preservation_contract_sha256'] != PRIOR_CONTRACT_SHA256:
            raise GateError('SOURCE_PRESERVATION')
        files = dict(prior['files'])
        for name, replacement in contract['replacements'].items():
            if (set(replacement) != {'approved_sha256', 'sha256'} or
                    files.get(name) != replacement['approved_sha256'] or
                    not re.fullmatch(r'[0-9a-f]{64}', replacement['sha256'])):
                raise GateError('SOURCE_PRESERVATION')
            files[name] = replacement['sha256']
        return dict(prior, version=3, files=files, preserved_original_files=431,
                    reviewed_replacements=3, preservation_contract_sha256=CONTRACT_SHA256,
                    prior_preservation_contract_sha256=PRIOR_CONTRACT_SHA256,
                    historical_v2_fixture_sha256=contract['historical_v2_fixture']['sha256'])
    except (OSError, ValueError, KeyError, TypeError):
        raise GateError('SOURCE_PRESERVATION') from None
