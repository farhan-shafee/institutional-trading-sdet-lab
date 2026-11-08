"""Require the unchanged historical13 and current11 source controls before native allocation."""
import hashlib
import io
import json
from pathlib import Path
import stat
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools/fix-session'))
from gate import GateError, run_bounded
import preservation_controls as v2_controls
from preservation_v2 import load_preservation as load_v2
from preservation_v3 import APPROVED_PATHS, FIXTURE, load_preservation

V2_CONTROL_FILES = (
    'tools/fix-session/gate.py', 'tools/fix-session/preservation_v2.py',
    'tools/fix-session/preservation_controls.py', 'tools/fix-session/preservation.json',
    'tools/fix-session/preservation-v2.json', 'tests/preservation-v2/test_controls.py',
    'tests/preservation-admission/test_admission.py',
)
PRESERVATION = tuple('test_v3_controls.PreservationV3.' + name for name in (
    'test_exact_three_approved_bytes_are_admitted_and_v2_remains_strict',
    'test_every_other_original_file_remains_protected',
    'test_each_approved_path_requires_its_exact_hash',
    'test_missing_any_contract_cannot_fall_back',
    'test_contract_edits_cannot_self_approve_a_hash_or_extra_path',
    'test_symlinked_chain_metadata_is_rejected',
    'test_mid_run_contract_or_fixture_change_is_rejected',
    'test_historical_fixture_is_exact_and_cannot_replace_current_admission',
))
CALLERS = (
    'test_v3_callers.NativeCallers.test_all_native_callers_admit_exact_approved_source_before_allocation',
    'test_v3_callers.NativeCallers.test_all_native_callers_reject_an_unapproved_original_before_commands',
)
ADMISSION = ('test_v3_controls.AdmissionV3.test_only_complete_typed_v3_receipt_is_admitted',)
CONTROL_RECEIPT = {
    'version': 1, 'scope': 'phase4-posttrade-preservation-controls-v3',
    'preservation_controls': 18, 'admission_controls': 6, 'passed': 24,
    'failures': 0, 'errors': 0, 'skipped': 0, 'expected_failures': 0,
    'unexpected_successes': 0,
}

def admit_control_receipt(text):
    try:
        receipt = json.loads(text.splitlines()[-1])
        if (not isinstance(receipt, dict) or set(receipt) != set(CONTROL_RECEIPT) or
                any(type(receipt[key]) is not type(value) or receipt[key] != value
                    for key, value in CONTROL_RECEIPT.items())):
            raise ValueError()
    except (ValueError, TypeError, IndexError, AttributeError):
        raise GateError('PRESERVATION_CONTROL_ADMISSION') from None

def stage_v2_controls(root, stage):
    """Historical fixtures are only for unchanged controls, never a build context."""
    try:
        root, stage = Path(root), Path(stage)
        active = load_preservation(root)
        archive = root / FIXTURE
        if archive.is_symlink() or not stat.S_ISREG(archive.stat().st_mode):
            raise GateError('SOURCE_PRESERVATION')
        with archive.open('rb') as source:
            raw = source.read(1024 * 1024 + 1)
        if (len(raw) > 1024 * 1024 or
                hashlib.sha256(raw).hexdigest() != active['historical_v2_fixture_sha256']):
            raise GateError('SOURCE_PRESERVATION')
        historical = {}
        with zipfile.ZipFile(io.BytesIO(raw)) as bundle:
            entries = bundle.infolist()
            if (len(entries) != 3 or {entry.filename for entry in entries} != APPROVED_PATHS or
                    sum(entry.file_size for entry in entries) > 1024 * 1024):
                raise GateError('SOURCE_PRESERVATION')
            for entry in entries:
                with bundle.open(entry) as source:
                    historical[entry.filename] = source.read(1024 * 1024 + 1)
        prior = load_v2(root)
        for name, digest in prior['files'].items():
            payload = historical[name] if name in historical else (root / name).read_bytes()
            if hashlib.sha256(payload).hexdigest() != digest:
                raise GateError('SOURCE_PRESERVATION')
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
        for name in V2_CONTROL_FILES:
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((root / name).read_bytes())
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile):
        raise GateError('SOURCE_PRESERVATION') from None

def main():
    with tempfile.TemporaryDirectory(prefix='tradeflow-v2-controls-') as directory:
        stage = Path(directory)
        stage_v2_controls(ROOT, stage)
        log = stage / 'historical-v2-controls.log'
        run_bounded([sys.executable, '-B', 'tools/fix-session/preservation_controls.py'],
                    log, 30, max_bytes=1024 * 1024, cwd=stage)
        text = log.read_text()
        print(text, end='', flush=True)
        v2_controls.admit_control_receipt(text)
    expected = PRESERVATION + ADMISSION
    count = v2_controls._execute('tests/preservation-v3', expected)
    count += v2_controls._execute('tests/preservation-v3-callers', CALLERS)
    if (len(PRESERVATION) + len(CALLERS) + v2_controls.CONTROL_RECEIPT['preservation_controls'] !=
            CONTROL_RECEIPT['preservation_controls'] or
            len(ADMISSION) + v2_controls.CONTROL_RECEIPT['admission_controls'] !=
            CONTROL_RECEIPT['admission_controls'] or
            count + v2_controls.CONTROL_RECEIPT['passed'] != CONTROL_RECEIPT['passed']):
        raise GateError('PRESERVATION_CONTROL_ADMISSION')
    print(json.dumps(CONTROL_RECEIPT, sort_keys=True), flush=True)

if __name__ == '__main__':
    try:
        main()
    except GateError as error:
        print('PRESERVATION_CONTROLS_FAILED ' + str(error), file=sys.stderr, flush=True)
        raise SystemExit(1)
