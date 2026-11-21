"""Run all prior controls in isolated historical inputs, then require the v5 controls."""
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
from gate import GateError, require_same_inputs, run_bounded
from preservation_controls import _execute
import preservation_v4_controls as prior_controls
from preservation_v4 import FIXTURE as V3_ARCHIVE, load_preservation as load_v4
from preservation_v5 import ARCHIVE, CONTRACT, input_identity, load_preservation, regular_path, verify_preserved

HISTORICAL_CALLERS = (
    'scripts/test-fix-session.py', 'scripts/test-fix-live-application.py',
    'scripts/verify-posttrade-journey.py',
)
HISTORICAL_CONTROLS = (
    'tools/fix-session/Dockerfile', 'tools/fix-session/preservation-v4.json',
    'tools/fix-session/preservation_v4.py', 'tools/fix-session/preservation_v4_controls.py',
    'tests/preservation-v4/test_v4_controls.py', 'tests/preservation-v4-callers/test_v4_callers.py',
)
TEST_FILE = 'tests/preservation-v5/test_v5_controls.py'
PRESERVATION = tuple('test_v5_controls.PreservationV5.' + name for name in (
    'test_exact_two_docs_preserve_every_other_hash',
    'test_altered_documents_or_financial_source_fail_closed',
    'test_missing_changed_or_redirected_admission_is_refused',
    'test_archive_isolated_and_bound_to_exact_old_bytes',
    'test_native_callers_admit_v5_before_commands',
))
ADMISSION = ('test_v5_controls.AdmissionV5.test_only_complete_typed_v5_receipt_is_admitted',)
CONTROL_RECEIPT = dict(
    version=1, scope='phase4-closeout-preservation-controls-v5',
    preservation_controls=37, admission_controls=8, passed=45, failures=0, errors=0,
    skipped=0, expected_failures=0, unexpected_successes=0,
)


def admit_control_receipt(text):
    try:
        receipt = json.loads(text.splitlines()[-1])
        if (not isinstance(receipt, dict) or set(receipt) != set(CONTROL_RECEIPT) or
                any(type(receipt[key]) is not type(value) or receipt[key] != value
                    for key, value in CONTROL_RECEIPT.items())):
            raise ValueError()
    except (ValueError, TypeError, IndexError, AttributeError):
        raise GateError('PRESERVATION_CONTROL_ADMISSION') from None


def historical_inputs(root):
    return set(load_v4(root)['files']) | set(prior_controls.V3_CONTROL_FILES) | {
        *HISTORICAL_CONTROLS, *HISTORICAL_CALLERS, V3_ARCHIVE,
    }


def stage_v4_controls(root, stage):
    """Restore known v4 bytes only into a fresh, isolated historical control directory."""
    try:
        root, stage = Path(root), Path(stage)
        active = load_preservation(root)
        verify_preserved(root, active['files'])
        prior = load_v4(root)
        fixture = active['historical_v4_fixture']
        expected = fixture['files']
        if (fixture['file'] != ARCHIVE or
                set(expected) != {'README.md', 'docs/RAILWAY_PRODUCTION.md', *HISTORICAL_CALLERS} or
                any(expected[name] != prior['files'][name]
                    for name in ('README.md', 'docs/RAILWAY_PRODUCTION.md'))):
            raise GateError('SOURCE_PRESERVATION')
        with regular_path(root, ARCHIVE).open('rb') as archive:
            raw = archive.read(256 * 1024 + 1)
        if len(raw) > 256 * 1024 or hashlib.sha256(raw).hexdigest() != fixture['sha256']:
            raise GateError('SOURCE_PRESERVATION')
        restored = {}
        with zipfile.ZipFile(io.BytesIO(raw)) as bundle:
            entries = bundle.infolist()
            if (len(entries) != len(expected) or {e.filename for e in entries} != set(expected) or
                    sum(e.file_size for e in entries) > 512 * 1024):
                raise GateError('SOURCE_PRESERVATION')
            for entry in entries:
                if not stat.S_ISREG(entry.external_attr >> 16):
                    raise GateError('SOURCE_PRESERVATION')
                data = bundle.read(entry)
                if hashlib.sha256(data).hexdigest() != expected[entry.filename]:
                    raise GateError('SOURCE_PRESERVATION')
                restored[entry.filename] = data
        pins = active['historical_v4_controls']
        if set(pins) != set(HISTORICAL_CONTROLS):
            raise GateError('SOURCE_PRESERVATION')
        stage.mkdir(exist_ok=False)
        for name in sorted(historical_inputs(root)):
            payload = restored[name] if name in restored else regular_path(root, name).read_bytes()
            digest = pins.get(name, prior['files'].get(name))
            if digest is not None and hashlib.sha256(payload).hexdigest() != digest:
                raise GateError('SOURCE_PRESERVATION')
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile):
        raise GateError('SOURCE_PRESERVATION') from None


def main():
    paths = historical_inputs(ROOT) | {CONTRACT, ARCHIVE, TEST_FILE,
        'tools/fix-session/preservation_v5.py', 'tools/fix-session/preservation_v5_controls.py',
        'scripts/verify-posttrade-journey.ts'}
    before = input_identity(ROOT, paths)
    with tempfile.TemporaryDirectory(prefix='tradeflow-v4-controls-') as directory:
        isolated = Path(directory) / 'source'
        stage_v4_controls(ROOT, isolated)
        log = Path(directory) / 'historical-v4-controls.log'
        run_bounded([sys.executable, '-B', 'tools/fix-session/preservation_v4_controls.py'],
                    log, 30, max_bytes=1024 * 1024, cwd=isolated)
        text = log.read_text()
        prior_controls.admit_control_receipt(text)
        print(text, end='', flush=True)
    count = _execute('tests/preservation-v5', PRESERVATION + ADMISSION)
    prior = prior_controls.CONTROL_RECEIPT
    if (len(PRESERVATION) + prior['preservation_controls'] != CONTROL_RECEIPT['preservation_controls'] or
            len(ADMISSION) + prior['admission_controls'] != CONTROL_RECEIPT['admission_controls'] or
            count + prior['passed'] != CONTROL_RECEIPT['passed']):
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
