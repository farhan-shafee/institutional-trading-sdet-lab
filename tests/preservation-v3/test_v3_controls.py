"""Exact owner-approved v3 source admission, including the immutable v2 chain."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools/fix-session'))
from gate import GateError, verify_preserved, input_identity, require_same_inputs
from preservation_v2 import load_preservation as load_v2

BASE = 'tools/fix-session/preservation.json'
V2 = 'tools/fix-session/preservation-v2.json'
V3 = 'tools/fix-session/preservation-v3.json'
ARCHIVE = 'tools/fix-session/preservation-v2-source.zip'
REPLACEMENTS = {
    'app/server/fixed-income-workflow/routes.ts': '01758c9baeeb1e00d70240543dad53f83b361e5837c2c6193c556524b35c704f',
    'app/server/fixed-income.ts': '83c6a36eea9eaa9b7ae6b09884d4b99edb105ce7a6d11b5991d2681ebe016f13',
    'contracts/openapi.yaml': 'cc8266a374c8b0455836dd84824a10e3bdfc5a74ff463e022b9b9f1b27baf3ca',
}
RECEIPT = {
    'version': 1, 'scope': 'phase4-posttrade-preservation-controls-v3',
    'preservation_controls': 18, 'admission_controls': 6, 'passed': 24,
    'failures': 0, 'errors': 0, 'skipped': 0, 'expected_failures': 0,
    'unexpected_successes': 0,
}

def module(name):
    path = ROOT / 'tools/fix-session' / (name + '.py')
    spec = importlib.util.spec_from_file_location(name + '_test', path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

class PreservationV3(unittest.TestCase):
    def setUp(self):
        self.assertTrue((ROOT / 'tools/fix-session/preservation_v3.py').is_file(),
                        'The approved three-file v3 admission is not implemented.')
        self.loader = module('preservation_v3')
        self.controls = module('preservation_v3_controls')
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.baseline = json.loads((ROOT / BASE).read_text())
        for name in [BASE, V2, V3, ARCHIVE, *self.baseline['files']]:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((ROOT / name).read_bytes())

    def test_exact_three_approved_bytes_are_admitted_and_v2_remains_strict(self):
        prior = load_v2(self.root)
        expected = dict(prior['files'])
        expected.update(REPLACEMENTS)
        loaded = self.loader.load_preservation(self.root)
        self.assertEqual(loaded['files'], expected)
        self.assertEqual(len(loaded['files']), 434)
        self.assertEqual((loaded['version'], loaded['preserved_original_files'],
                          loaded['reviewed_replacements']), (3, 431, 3))
        self.assertEqual({k for k in expected if expected[k] != prior['files'][k]},
                         set(REPLACEMENTS))
        verify_preserved(self.root, loaded['files'])
        with self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
            verify_preserved(self.root, prior['files'])

    def test_every_other_original_file_remains_protected(self):
        target = self.root / 'README.md'
        target.write_bytes(target.read_bytes() + b'unauthorized')
        with self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
            verify_preserved(self.root, self.loader.load_preservation(self.root)['files'])

    def test_each_approved_path_requires_its_exact_hash(self):
        for name in REPLACEMENTS:
            with self.subTest(path=name):
                target = self.root / name
                original = target.read_bytes()
                try:
                    target.write_bytes(original + b'\n')
                    with self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
                        verify_preserved(self.root, self.loader.load_preservation(self.root)['files'])
                finally:
                    target.write_bytes(original)

    def test_missing_any_contract_cannot_fall_back(self):
        for name in [BASE, V2, V3]:
            target = self.root / name
            original = target.read_bytes()
            try:
                target.unlink()
                with self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
                    self.loader.load_preservation(self.root)
            finally:
                target.write_bytes(original)

    def test_contract_edits_cannot_self_approve_a_hash_or_extra_path(self):
        target = self.root / V3
        original = target.read_bytes()
        for kind in ['hash', 'preimage', 'fourth_path', 'scope', 'prior_contract']:
            value = json.loads(original)
            name = 'app/server/fixed-income.ts'
            if kind == 'hash':
                value['replacements'][name]['sha256'] = '0' * 64
            elif kind == 'preimage':
                value['replacements'][name]['approved_sha256'] = '0' * 64
            elif kind == 'fourth_path':
                value['replacements']['README.md'] = {
                    'approved_sha256': self.baseline['files']['README.md'], 'sha256': '0' * 64}
            elif kind == 'scope':
                value['scope'] = 'all-future-changes'
            else:
                value['prior_contract_sha256'] = '0' * 64
            try:
                target.write_text(json.dumps(value))
                with self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
                    self.loader.load_preservation(self.root)
            finally:
                target.write_bytes(original)

    def test_symlinked_chain_metadata_is_rejected(self):
        for name in [BASE, V2, V3]:
            target = self.root / name
            original = target.read_bytes()
            shadow = target.with_suffix('.shadow')
            shadow.write_bytes(original)
            try:
                target.unlink()
                target.symlink_to(shadow)
                with self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
                    self.loader.load_preservation(self.root)
            finally:
                target.unlink()
                target.write_bytes(original)
                shadow.unlink()

    def test_mid_run_contract_or_fixture_change_is_rejected(self):
        names = [BASE, V2, V3, ARCHIVE]
        for name in [V3, ARCHIVE]:
            before = input_identity(self.root, names)
            target = self.root / name
            original = target.read_bytes()
            try:
                target.write_bytes(original + b'\n')
                with self.assertRaisesRegex(GateError, '^SOURCE_CHANGED_DURING_GATE$'):
                    require_same_inputs(before, input_identity(self.root, names))
            finally:
                target.write_bytes(original)

    def test_historical_fixture_is_exact_and_cannot_replace_current_admission(self):
        for name in self.controls.V2_CONTROL_FILES:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((ROOT / name).read_bytes())
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            self.controls.stage_v2_controls(self.root, stage)
            verify_preserved(stage, load_v2(stage)['files'])
            self.assertNotEqual((stage / 'app/server/fixed-income.ts').read_bytes(),
                                (self.root / 'app/server/fixed-income.ts').read_bytes())
        target = self.root / ARCHIVE
        original = target.read_bytes()
        for kind in ['corrupt', 'missing', 'symlink']:
            shadow = target.with_suffix('.shadow')
            try:
                if kind == 'corrupt':
                    target.write_bytes(original + b'changed')
                elif kind == 'missing':
                    target.unlink()
                else:
                    shadow.write_bytes(original)
                    target.unlink()
                    target.symlink_to(shadow)
                with tempfile.TemporaryDirectory() as directory:
                    with self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
                        self.controls.stage_v2_controls(self.root, Path(directory))
            finally:
                if target.exists() or target.is_symlink():
                    target.unlink()
                target.write_bytes(original)
                if shadow.exists():
                    shadow.unlink()

class AdmissionV3(unittest.TestCase):
    def test_only_complete_typed_v3_receipt_is_admitted(self):
        self.assertTrue((ROOT / 'tools/fix-session/preservation_v3_controls.py').is_file(),
                        'The complete v3 control receipt is not implemented.')
        controls = module('preservation_v3_controls')
        controls.admit_control_receipt('diagnostic\n' + json.dumps(RECEIPT))
        wrong = [
            {}, {**RECEIPT, 'passed': 13}, {**RECEIPT, 'preservation_controls': 8},
            {**RECEIPT, 'skipped': 1}, {**RECEIPT, 'version': True},
            {**RECEIPT, 'scope': 'phase4a-preservation-controls-v2'},
            {k: v for k, v in RECEIPT.items() if k != 'errors'},
        ]
        for receipt in wrong:
            with self.subTest(receipt=receipt):
                with self.assertRaisesRegex(GateError, '^PRESERVATION_CONTROL_ADMISSION$'):
                    controls.admit_control_receipt(json.dumps(receipt))

if __name__ == '__main__':
    unittest.main()
