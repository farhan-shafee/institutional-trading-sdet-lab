"""Exact documentation closeout over the immutable Phase 4 preservation contract."""
from pathlib import Path

from gate import GateError
from preservation_v2 import _metadata
from preservation_v4 import (
    CONTRACT_SHA256 as PRIOR_SHA256,
    input_identity,
    load_preservation as load_v4,
    regular_path,
    verify_preserved,
)

CONTRACT = 'tools/fix-session/preservation-v5.json'
ARCHIVE = 'tools/fix-session/preservation-v4-source.zip'
CONTRACT_SHA256 = 'e6f369e637a31927c8ebce0c68e576fe7b9e8645fbba0afadcc71198b254c587'
APPROVED_SOURCE = '20d59355285e14dc3985ee478559a6bb335db190'
APPROVED_PATHS = frozenset({'README.md', 'docs/RAILWAY_PRODUCTION.md'})


def load_preservation(root):
    """Admit only the two reviewed replacements and retain all inherited paths."""
    try:
        root = Path(root)
        regular_path(root, CONTRACT)
        contract = _metadata(root, CONTRACT, CONTRACT_SHA256)
        prior = load_v4(root)
        replacements = contract['replacements']
        if (type(contract['version']) is not int or contract['version'] != 5 or
                contract['scope'] != 'phase4-public-documentation-closeout' or
                contract['approved_source_commit'] != APPROVED_SOURCE or
                contract['prior_contract_sha256'] != PRIOR_SHA256 or
                prior['preservation_contract_sha256'] != PRIOR_SHA256 or
                set(replacements) != APPROVED_PATHS):
            raise GateError('SOURCE_PRESERVATION')
        files = dict(prior['files'])
        for name, replacement in replacements.items():
            if files.get(name) != replacement['approved_sha256']:
                raise GateError('SOURCE_PRESERVATION')
            files[name] = replacement['sha256']
        return dict(prior, version=5, files=files, preserved_original_files=414,
                    reviewed_replacements=20, layer_replacements=2,
                    preservation_contract_sha256=CONTRACT_SHA256,
                    prior_preservation_contract_sha256=PRIOR_SHA256,
                    historical_v4_fixture=contract['historical_v4_fixture'],
                    historical_v4_controls=contract['historical_v4_controls'])
    except (OSError, KeyError, TypeError, ValueError):
        raise GateError('SOURCE_PRESERVATION') from None
