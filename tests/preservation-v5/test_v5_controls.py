"""Admission of the two exact documentation revisions approved for release closeout."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools/fix-session'))
from gate import GateError, require_same_inputs
from preservation_v4 import load_preservation as load_v4, verify_preserved
from preservation_v5 import ARCHIVE, CONTRACT, input_identity, load_preservation
from preservation_v5_controls import admit_control_receipt, historical_inputs, stage_v4_controls

SCRIPTS = ('test-fix-session.py', 'test-fix-live-application.py', 'verify-posttrade-journey.py')
DOCS = {
    'README.md': 'c92ea60ee9c6fae0d948ee157b06ae7cb1f288864f5566ebc78e9704211c730e',
    'docs/RAILWAY_PRODUCTION.md': 'a739bca0d524cb3049b00273e8d3ff3ca94076d38b277c09301e4461b326e120',
}
RECEIPT = dict(version=1, scope='phase4-closeout-preservation-controls-v5',
               preservation_controls=37, admission_controls=8, passed=45,
               failures=0, errors=0, skipped=0, expected_failures=0,
               unexpected_successes=0)


class PreservationV5(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name) / 'current'
        for name in historical_inputs(ROOT) | {CONTRACT, ARCHIVE}:
            dest = self.root / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, dest)

    def test_exact_two_docs_preserve_every_other_hash(self):
        prior = load_v4(self.root)
        active = load_preservation(self.root)
        self.assertEqual(active['files'], prior['files'] | DOCS)
        self.assertEqual(len(active['files']), 434)
        self.assertEqual((active['version'], active['preserved_original_files'],
                          active['reviewed_replacements'], active['layer_replacements']),
                         (5, 414, 20, 2))
        verify_preserved(self.root, active['files'])
        with self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
            verify_preserved(self.root, prior['files'])

    def test_altered_documents_or_financial_source_fail_closed(self):
        active = load_preservation(self.root)['files']
        for name in [*DOCS, 'app/server/fixed-income.ts']:
            target = self.root / name
            original = target.read_bytes()
            try:
                target.write_bytes(original + b'\n')
                with self.subTest(path=name), self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
                    verify_preserved(self.root, active)
            finally:
                target.write_bytes(original)

    def test_missing_changed_or_redirected_admission_is_refused(self):
        target = self.root / CONTRACT
        original = target.read_bytes()
        before = input_identity(self.root, [CONTRACT, ARCHIVE, *DOCS])
        target.write_bytes(original + b'\n')
        with self.assertRaisesRegex(GateError, '^SOURCE_CHANGED_DURING_GATE$'):
            require_same_inputs(before, input_identity(self.root, [CONTRACT, ARCHIVE, *DOCS]))
        with self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
            load_preservation(self.root)
        target.unlink()
        with self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
            load_preservation(self.root)
        shadow = self.root / 'shadow.json'
        shadow.write_bytes(original)
        target.symlink_to(shadow)
        with self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
            load_preservation(self.root)
        with self.assertRaisesRegex(GateError, '^INPUT_PATHS$'):
            input_identity(self.root, [CONTRACT])

    def test_archive_isolated_and_bound_to_exact_old_bytes(self):
        stage = self.root.parent / 'historical'
        stage_v4_controls(self.root, stage)
        verify_preserved(stage, load_v4(stage)['files'])
        with self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
            load_preservation(stage)
        verify_preserved(self.root, load_preservation(self.root)['files'])
        archive = self.root / ARCHIVE
        archive.write_bytes(archive.read_bytes() + b'changed')
        with self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
            stage_v4_controls(self.root, self.root.parent / 'refused')

    def test_native_callers_admit_v5_before_commands(self):
        for name in SCRIPTS:
            spec = importlib.util.spec_from_file_location('v5_' + name, ROOT / 'scripts' / name)
            host = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(host)
            for corrupt in (False, True):
                with self.subTest(caller=name, corrupt=corrupt):
                    doc = self.root / 'docs/RAILWAY_PRODUCTION.md'
                    original = doc.read_bytes()
                    if corrupt:
                        doc.write_bytes(original + b'changed')
                    def boundary(args, *unused, **kwargs):
                        self.assertEqual(args, ['node', '--version'])
                        raise host.GateError('ADMITTED_SOURCE_BOUNDARY')
                    try:
                        with patch.object(host, 'ROOT', self.root), \
                             patch.object(host, 'require_tool', side_effect=lambda tool: tool), \
                             patch.object(host, 'run_bounded', side_effect=boundary) as commands, \
                             contextlib.redirect_stdout(io.StringIO()):
                            code = 'SOURCE_PRESERVATION' if corrupt else 'ADMITTED_SOURCE_BOUNDARY'
                            with self.assertRaisesRegex(GateError, f'^{code}$'):
                                host.main()
                        self.assertEqual(commands.call_count, 0 if corrupt else 1)
                    finally:
                        doc.write_bytes(original)


class AdmissionV5(unittest.TestCase):
    def test_only_complete_typed_v5_receipt_is_admitted(self):
        admit_control_receipt(json.dumps(RECEIPT))
        for invalid in ['', '{}', json.dumps(dict(RECEIPT, passed=44)),
                        json.dumps(dict(RECEIPT, failures=False)),
                        json.dumps(dict(RECEIPT, skipped=1)),
                        json.dumps(dict(RECEIPT, scope='phase4-posttrade-preservation-controls-v4'))]:
            with self.subTest(receipt=invalid), self.assertRaisesRegex(
                    GateError, '^PRESERVATION_CONTROL_ADMISSION$'):
                admit_control_receipt(invalid)
