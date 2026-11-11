"""Exact owner-approved v4 source admission, including the immutable v2 chain."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools/fix-session'))
from gate import GateError, verify_preserved, input_identity, require_same_inputs
from preservation_v3 import load_preservation as load_v3

BASE = 'tools/fix-session/preservation.json'
V2 = 'tools/fix-session/preservation-v2.json'
V3 = 'tools/fix-session/preservation-v3.json'
OLD_ARCHIVE = 'tools/fix-session/preservation-v2-source.zip'
V4 = 'tools/fix-session/preservation-v4.json'
ARCHIVE = 'tools/fix-session/preservation-v3-source.zip'
REPLACEMENTS = {'README.md': '2d1dcc3a426b241c9f397defa35cb805c46a942d0a0b74453a44a769989698f1', 'app/domain/workflow/reconciliation.ts': '2ca27c7b7e99934a301a83f7e7947d26d8cbf4b964165739731074954629cc72', 'app/public/fixed-income.ts': '21db3e39cca42cdb8402a5508a34633de9a1a615a98b39a09234c80f6a7d0ce0', 'app/public/index.html': '45802e9001b02c26983fefc9ab3a66e4c4dd4634199ac2c92e5a6f6b9cd1de0b', 'app/public/rfq.ts': '73ddf4094e7b2cbc6b140478feb7bff6dc9c3b002b5003cb0f9a647131c0fa92', 'app/public/style.css': '9d7d53b6c51752dd6fb41f0fada0b9ca400fd6c6dfbec83460260b0a16fb711f', 'app/server/configuration.ts': '525d15a94837da87ff67a668fe5648f9ce104d9de25cca70cfc99d1ee7dd4502', 'app/server/fixed-income-workflow/routes.ts': 'de471d9bd484084ce6b86fb2d48f2943a7b249d86d1b6dbc972d400069848279', 'app/server/index.ts': 'a488205e23711477f9ecbc78601213adccd56754bce3efe6beca7e30642df024', 'app/server/public-demo/configuration.ts': '7da4a2f93767a5e44143576abdcb23d360bed8bd62446754b59b396022222ca3', 'app/server/public-demo/maintenance.ts': 'fa8803631fca53e18c9ff071f470e2683fdef37a67dd3e9d4e790ec820bc52fc', 'app/server/public-demo/profile.ts': 'b20befa482255f7c128988c75544d0088d0c813d030079c41b1de652317be54d', 'app/server/public-demo/workspaces.ts': '499b2f61e9c65f3ae64a933b3f0b1dc3c0f90092477146fa50a5521aa0cc2b35', 'app/server/reconciliation/database.ts': 'e6708603643e1e37cfd271d0be640e00f339fdc3542ff49bbb906938effdf903', 'app/server/reconciliation/manifest.ts': '81a539fa35ea50d38d11efa8de2d8f06c80d954459e29f4118d63548c74ba41f', 'app/server/reconciliation/runner.ts': 'b9ad742d5839992507760659390095d7b4f6be80cff34457130c9d7752f74be3', 'app/server/reconciliation/service.ts': 'be9e26b4aad5b995786359b2ac9d9eb95f9a0b1156757bdd20bdfcd18c826c34', 'contracts/openapi.yaml': 'ad798be47f7ac9c917f4f5c3ceba7151c708a29e8b21535f98eabdd8ad1a8b63'}

RECEIPT = {
    'version': 1, 'scope': 'phase4-posttrade-preservation-controls-v4',
    'preservation_controls': 32, 'admission_controls': 7, 'passed': 39,
    'failures': 0, 'errors': 0, 'skipped': 0, 'expected_failures': 0,
    'unexpected_successes': 0,
}

def module(name):
    path = ROOT / 'tools/fix-session' / (name + '.py')
    spec = importlib.util.spec_from_file_location(name + '_test', path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

class PreservationV4(unittest.TestCase):
    def setUp(self):
        self.assertTrue((ROOT / 'tools/fix-session/preservation_v4.py').is_file(),
                        'The approved 18-file v4 admission is not implemented.')
        self.loader = module('preservation_v4')
        self.controls = module('preservation_v4_controls')
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.baseline = json.loads((ROOT / BASE).read_text())
        for name in [BASE, V2, V3, V4, OLD_ARCHIVE, ARCHIVE, *self.baseline['files']]:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((ROOT / name).read_bytes())

    def test_exact_eighteen_approved_bytes_are_admitted_and_v3_remains_strict(self):
        prior = load_v3(self.root)
        expected = dict(prior['files'])
        expected.update(REPLACEMENTS)
        loaded = self.loader.load_preservation(self.root)
        self.assertEqual(loaded['files'], expected)
        self.assertEqual(len(loaded['files']), 434)
        self.assertEqual((loaded['version'], loaded['preserved_original_files'],
                          loaded['reviewed_replacements']), (4, 415, 19))
        self.assertEqual({k for k in expected if expected[k] != prior['files'][k]},
                         set(REPLACEMENTS))
        verify_preserved(self.root, loaded['files'])
        with self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
            verify_preserved(self.root, prior['files'])

    def test_every_other_original_file_remains_protected(self):
        target = self.root / 'app/server/fixed-income.ts'
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
        for name in [BASE, V2, V3, V4]:
            target = self.root / name
            original = target.read_bytes()
            try:
                target.unlink()
                with self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
                    self.loader.load_preservation(self.root)
            finally:
                target.write_bytes(original)

    def test_contract_edits_cannot_self_approve_a_hash_or_extra_path(self):
        target = self.root / V4
        original = target.read_bytes()
        for kind in ['hash', 'preimage', 'extra_path', 'scope', 'prior_contract']:
            value = json.loads(original)
            name = 'app/public/rfq.ts'
            if kind == 'hash':
                value['replacements'][name]['sha256'] = '0' * 64
            elif kind == 'preimage':
                value['replacements'][name]['approved_sha256'] = '0' * 64
            elif kind == 'extra_path':
                value['replacements']['app/server/fixed-income.ts'] = {
                    'approved_sha256': self.baseline['files']['app/server/fixed-income.ts'], 'sha256': '0' * 64}
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
        for name in [BASE, V2, V3, V4]:
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
        names = [BASE, V2, V3, V4, OLD_ARCHIVE, ARCHIVE]
        for name in [V4, ARCHIVE]:
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
        for name in self.controls.V3_CONTROL_FILES:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((ROOT / name).read_bytes())
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            self.controls.stage_v3_controls(self.root, stage)
            verify_preserved(stage, load_v3(stage)['files'])
            self.assertNotEqual((stage / 'app/public/rfq.ts').read_bytes(),
                                (self.root / 'app/public/rfq.ts').read_bytes())
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
                        self.controls.stage_v3_controls(self.root, Path(directory))
            finally:
                if target.exists() or target.is_symlink():
                    target.unlink()
                target.write_bytes(original)
                if shadow.exists():
                    shadow.unlink()

    def test_symlinked_live_source_and_parent_directory_are_rejected(self):
        for name in ['README.md', 'app/public/rfq.ts']:
            target = self.root / name
            raw = target.read_bytes()
            shadow = target.with_suffix('.shadow')
            shadow.write_bytes(raw)
            try:
                target.unlink()
                target.symlink_to(shadow)
                with self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
                    self.loader.verify_preserved(self.root, self.loader.load_preservation(self.root)['files'])
            finally:
                target.unlink()
                target.write_bytes(raw)
                shadow.unlink()
        directory = self.root / 'app/public'
        shadow = self.root / 'app/public-shadow'
        directory.rename(shadow)
        directory.symlink_to(shadow, target_is_directory=True)
        with self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
            self.loader.verify_preserved(self.root, self.loader.load_preservation(self.root)['files'])

        # Standalone controls must refuse redirected current test directories too.
        names = [*self.controls.V3_CONTROL_FILES,
                 'tests/preservation-v4/test_v4_controls.py',
                 'tests/preservation-v4-callers/test_v4_callers.py',
                 'tools/fix-session/preservation_v4.py',
                 'tools/fix-session/preservation_v4_controls.py',
                 'scripts/test-fix-session.py', 'scripts/test-fix-live-application.py',
                 'scripts/verify-posttrade-journey.py', 'tools/fix-session/Dockerfile']
        for name in names:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((ROOT / name).read_bytes())
        def check(expected):
            with patch.object(self.controls, 'ROOT', self.root), patch.object(
                    self.controls, 'stage_v3_controls', side_effect=GateError('DISCOVERY_BOUNDARY')):
                with self.assertRaisesRegex(GateError, '^' + expected + '$'):
                    self.controls.main()
        check('DISCOVERY_BOUNDARY')
        for name in ['tests/preservation-v4', 'tests/preservation-v4-callers']:
            target = self.root / name
            shadow = target.with_name(target.name + '-shadow')
            target.rename(shadow)
            target.symlink_to(shadow, target_is_directory=True)
            try:
                check('INPUT_PATHS')
            finally:
                target.unlink()
                shadow.rename(target)

    def test_unpinned_control_source_cannot_enter_historical_fixture(self):
        for name in self.controls.V3_CONTROL_FILES:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((ROOT / name).read_bytes())
        target = self.root / 'tests/preservation-v3/test_v3_controls.py'
        target.write_bytes(target.read_bytes() + b'changed')
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
                self.controls.stage_v3_controls(self.root, Path(directory))

class AdmissionV4(unittest.TestCase):
    def test_only_complete_typed_v4_receipt_is_admitted(self):
        self.assertTrue((ROOT / 'tools/fix-session/preservation_v4_controls.py').is_file(),
                        'The complete v4 control receipt is not implemented.')
        controls = module('preservation_v4_controls')
        controls.admit_control_receipt('diagnostic\n' + json.dumps(RECEIPT))
        wrong = [
            {}, {**RECEIPT, 'passed': 13}, {**RECEIPT, 'passed': 38}, {**RECEIPT, 'preservation_controls': 8},
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
