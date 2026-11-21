"""Unchanged historical25 plus14 current controls, before native allocation."""
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
from gate import GateError, run_bounded, require_same_inputs
import preservation_controls as v2_controls
import preservation_v3_controls as v3_controls
from preservation_v3 import load_preservation as load_v3
from preservation_v4 import FIXTURE, load_preservation, regular_path, verify_preserved, input_identity

V3_CONTROL_FILES = ('tools/fix-session/gate.py', 'tools/fix-session/preflight.py', 'tools/fix-session/preservation_v2.py', 'tools/fix-session/preservation_controls.py', 'tools/fix-session/preservation.json', 'tools/fix-session/preservation-v2.json', 'tools/fix-session/preservation_v3.py', 'tools/fix-session/preservation_v3_controls.py', 'tools/fix-session/preservation-v3.json', 'tools/fix-session/preservation-v2-source.zip', 'tests/preservation-v2/test_controls.py', 'tests/preservation-admission/test_admission.py', 'tests/preservation-v3/test_v3_controls.py', 'tests/preservation-v3-callers/test_v3_callers.py', 'package.json', 'package-lock.json', 'scripts/test-fix-session.ts', 'scripts/verify-fix-session-compatibility.ts', 'verification/vendor/quickfix/FIX44.xml', 'tools/fix-session/Dockerfile.dockerignore', 'tools/fix-session/java/pom.xml', 'contracts/fix-session-runtime-v1.json', 'contracts/fix-live-application-v1.json', 'contracts/posttrade-native-v1.json', 'tools/fix-session/dependencies.lock.json', 'test-data/fix44/runtime/manifest.json', 'test-data/fix44/runtime/bindings.json', 'verification/fix-peer/go/go.mod', 'verification/fix-peer/go/go.sum')
PRESERVATION = ('test_v4_controls.PreservationV4.test_exact_eighteen_approved_bytes_are_admitted_and_v3_remains_strict', 'test_v4_controls.PreservationV4.test_every_other_original_file_remains_protected', 'test_v4_controls.PreservationV4.test_each_approved_path_requires_its_exact_hash', 'test_v4_controls.PreservationV4.test_missing_any_contract_cannot_fall_back', 'test_v4_controls.PreservationV4.test_contract_edits_cannot_self_approve_a_hash_or_extra_path', 'test_v4_controls.PreservationV4.test_symlinked_chain_metadata_is_rejected', 'test_v4_controls.PreservationV4.test_mid_run_contract_or_fixture_change_is_rejected', 'test_v4_controls.PreservationV4.test_historical_fixture_is_exact_and_cannot_replace_current_admission', 'test_v4_controls.PreservationV4.test_symlinked_live_source_and_parent_directory_are_rejected', 'test_v4_controls.PreservationV4.test_unpinned_control_source_cannot_enter_historical_fixture')
CALLERS = ('test_v4_callers.NativeCallers.test_all_native_callers_admit_exact_approved_source_before_allocation', 'test_v4_callers.NativeCallers.test_all_native_snapshots_detect_changes_to_every_new_control_dependency', 'test_v4_callers.NativeCallers.test_all_native_callers_reject_an_unapproved_original_before_commands')
ADMISSION = ('test_v4_controls.AdmissionV4.test_only_complete_typed_v4_receipt_is_admitted',)
CONTROL_RECEIPT = {
    'version': 1, 'scope': 'phase4-posttrade-preservation-controls-v4',
    'preservation_controls': 32, 'admission_controls': 7, 'passed': 39,
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

def stage_v3_controls(root, stage):
    """Verified isolated historical test source; never returned to a build/runtime."""
    try:
        root, stage = Path(root), Path(stage)
        active = load_preservation(root)
        verify_preserved(root, active['files'])
        fixture = active['historical_v3_fixture']
        archive = regular_path(root, FIXTURE)
        with archive.open('rb') as source:
            raw = source.read(2 * 1024 * 1024 + 1)
        if (len(raw) > 2 * 1024 * 1024 or
                hashlib.sha256(raw).hexdigest() != fixture['sha256']):
            raise GateError('SOURCE_PRESERVATION')
        historical = {}
        with zipfile.ZipFile(io.BytesIO(raw)) as bundle:
            entries = bundle.infolist()
            if (len(entries) != 22 or
                    {entry.filename for entry in entries} != set(fixture['files']) or
                    sum(entry.file_size for entry in entries) > 4 * 1024 * 1024):
                raise GateError('SOURCE_PRESERVATION')
            for entry in entries:
                if not stat.S_ISREG(entry.external_attr >> 16):
                    raise GateError('SOURCE_PRESERVATION')
                with bundle.open(entry) as source:
                    payload = source.read(4 * 1024 * 1024 + 1)
                if hashlib.sha256(payload).hexdigest() != fixture['files'][entry.filename]:
                    raise GateError('SOURCE_PRESERVATION')
                historical[entry.filename] = payload
        prior = load_v3(root)
        staged = dict(historical)
        for name, digest in prior['files'].items():
            payload = historical[name] if name in historical else regular_path(root, name).read_bytes()
            if hashlib.sha256(payload).hexdigest() != digest:
                raise GateError('SOURCE_PRESERVATION')
            staged[name] = payload
        if set(active['historical_control_files']) != set(V3_CONTROL_FILES):
            raise GateError('SOURCE_PRESERVATION')
        for name, digest in active['historical_control_files'].items():
            payload = regular_path(root, name).read_bytes()
            if hashlib.sha256(payload).hexdigest() != digest:
                raise GateError('SOURCE_PRESERVATION')
            staged[name] = payload
        # Nothing from the historical bundle is ever copied into the live checkout.
        for name, payload in staged.items():
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile):
        raise GateError('SOURCE_PRESERVATION') from None

def main():
    paths = (*V3_CONTROL_FILES, FIXTURE, 'tools/fix-session/preservation-v4.json',
             'tools/fix-session/preservation_v4.py', 'tools/fix-session/preservation_v4_controls.py',
             'tests/preservation-v4/test_v4_controls.py',
             'tests/preservation-v4-callers/test_v4_callers.py',
             'scripts/test-fix-session.py', 'scripts/test-fix-live-application.py',
             'scripts/verify-posttrade-journey.py', 'tools/fix-session/Dockerfile')
    before = input_identity(ROOT, paths)
    with tempfile.TemporaryDirectory(prefix='tradeflow-v3-controls-') as directory:
        stage = Path(directory)
        stage_v3_controls(ROOT, stage)
        log = stage / 'historical-v3-controls.log'
        run_bounded([sys.executable, '-B', 'tools/fix-session/preservation_v3_controls.py'],
                    log, 30, max_bytes=1024 * 1024, cwd=stage)
        text = log.read_text()
        print(text, end='', flush=True)
        v3_controls.admit_control_receipt(text)
    count = v2_controls._execute('tests/preservation-v4', PRESERVATION + ADMISSION)
    count += v2_controls._execute('tests/preservation-v4-callers', CALLERS)
    if (len(PRESERVATION) + len(CALLERS) + v3_controls.CONTROL_RECEIPT['preservation_controls'] !=
            CONTROL_RECEIPT['preservation_controls'] or
            len(ADMISSION) + v3_controls.CONTROL_RECEIPT['admission_controls'] !=
            CONTROL_RECEIPT['admission_controls'] or
            count + v3_controls.CONTROL_RECEIPT['passed'] != CONTROL_RECEIPT['passed']):
        raise GateError('PRESERVATION_CONTROL_ADMISSION')
    require_same_inputs(before, input_identity(ROOT, paths))
    verify_preserved(ROOT, load_preservation(ROOT)['files'])
    print(json.dumps(CONTROL_RECEIPT, sort_keys=True), flush=True)

if __name__ == '__main__':
    try:
        main()
    except GateError as error:
        print('PRESERVATION_CONTROLS_FAILED ' + str(error), file=sys.stderr, flush=True)
        raise SystemExit(1)
