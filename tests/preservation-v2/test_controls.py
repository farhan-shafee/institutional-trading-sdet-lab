"""Approved exact replacements must never become a general preservation bypass."""
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

REPLACEMENTS = {
    'app/server/fixed-income.ts': 'cca68918c45ecac3fce25649211466b30a1dc76c7759e89656ded72a5868fcf6',
    'contracts/openapi.yaml': 'dfb15fb8ddef03b35950c9fdb1276e860a280bf111209ea2164341b5522154c9',
}
BASE = 'tools/fix-session/preservation.json'
V2 = 'tools/fix-session/preservation-v2.json'

class PreservationV2(unittest.TestCase):
    def setUp(self):
        path = ROOT / 'tools/fix-session/preservation_v2.py'
        self.assertTrue(path.is_file(), 'Approved versioned preservation loader is missing.')
        spec = importlib.util.spec_from_file_location('preservation_v2_control', path)
        self.loader = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.loader)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.baseline = json.loads((ROOT / BASE).read_text())
        for name in [BASE, V2, *self.baseline['files']]:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((ROOT / name).read_bytes())

    def test_only_two_literal_approved_hashes_replace_the_original_map(self):
        expected = dict(self.baseline['files'])
        expected.update(REPLACEMENTS)
        loaded = self.loader.load_preservation(self.root)
        self.assertEqual(len(loaded['files']), 434)
        self.assertEqual(loaded['files'], expected)
        self.assertEqual(loaded['version'], 2)
        verify_preserved(self.root, loaded['files'])
        with self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
            verify_preserved(self.root, self.baseline['files'])

    def test_any_other_original_file_change_is_still_rejected(self):
        target = self.root / 'README.md'
        target.write_bytes(target.read_bytes() + b'\nunauthorized change\n')
        with self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
            verify_preserved(self.root, self.loader.load_preservation(self.root)['files'])

    def test_either_approved_replacement_is_bound_to_its_exact_bytes(self):
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

    def test_missing_versioned_contract_cannot_fall_back(self):
        (self.root / V2).unlink()
        with self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
            self.loader.load_preservation(self.root)

    def test_modified_replacement_hash_or_new_exception_cannot_self_approve(self):
        target = self.root / V2
        original = target.read_bytes()
        for kind in ['replacement', 'third_path', 'preimage', 'scope']:
            with self.subTest(kind=kind):
                value = json.loads(original)
                if kind == 'replacement':
                    value['replacements']['app/server/fixed-income.ts']['sha256'] = '0' * 64
                elif kind == 'third_path':
                    value['replacements']['README.md'] = {'original_sha256': self.baseline['files']['README.md'], 'sha256': '0' * 64}
                elif kind == 'preimage':
                    value['replacements']['app/server/fixed-income.ts']['original_sha256'] = '0' * 64
                else:
                    value['scope'] = 'all-future-changes'
                try:
                    target.write_text(json.dumps(value))
                    with self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
                        self.loader.load_preservation(self.root)
                finally:
                    target.write_bytes(original)

    def test_original_manifest_cannot_be_rewritten_to_accept_new_bytes(self):
        target = self.root / BASE
        value = json.loads(target.read_bytes())
        value['files']['README.md'] = hashlib.sha256(b'forged').hexdigest()
        target.write_text(json.dumps(value))
        with self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
            self.loader.load_preservation(self.root)

    def test_symlinked_contract_or_baseline_is_rejected(self):
        for name in [BASE, V2]:
            with self.subTest(path=name):
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

    def test_mid_run_contract_changes_are_not_same_inputs(self):
        before = input_identity(self.root, [BASE, V2])
        target = self.root / V2
        target.write_bytes(target.read_bytes() + b'\n')
        with self.assertRaisesRegex(GateError, '^SOURCE_CHANGED_DURING_GATE$'):
            require_same_inputs(before, input_identity(self.root, [BASE, V2]))
        with self.assertRaisesRegex(GateError, '^SOURCE_PRESERVATION$'):
            self.loader.load_preservation(self.root)

if __name__ == '__main__':
    unittest.main()
