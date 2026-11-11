"""Native entry points must admit only the approved current source before allocating."""
import ast
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ('test-fix-session.py', 'test-fix-live-application.py', 'verify-posttrade-journey.py')

class NativeCallers(unittest.TestCase):
    def fixture(self, directory):
        root = Path(directory)
        baseline = json.loads((ROOT / 'tools/fix-session/preservation.json').read_text())
        names = set(baseline['files'])
        names.update([
            'tools/fix-session/preservation.json', 'tools/fix-session/preservation-v2.json',
            'tools/fix-session/preservation-v3.json', 'tools/fix-session/preservation-v2-source.zip',
            'tools/fix-session/preservation-v4.json', 'tools/fix-session/preservation-v3-source.zip',
            'tools/fix-session/dependencies.lock.json', 'tools/fix-session/Dockerfile',
            'test-data/fix44/runtime/manifest.json', 'test-data/fix44/runtime/bindings.json',
            'contracts/fix-session-runtime-v1.json', 'contracts/fix-live-application-v1.json',
            'contracts/posttrade-native-v1.json', 'verification/fix-peer/go/go.mod',
            'verification/fix-peer/go/go.sum',
        ])
        for name in names:
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((ROOT / name).read_bytes())
        return root

    def host(self, name):
        spec = importlib.util.spec_from_file_location('v4_caller_' + name.replace('-', '_'),
                                                      ROOT / 'scripts' / name)
        host = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(host)
        return host

    def check(self, name, corrupt):
        host = self.host(name)
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            if corrupt:
                target = root / 'README.md'
                target.write_bytes(target.read_bytes() + b'unapproved')
            calls = []
            def boundary(args, *unused, **kwargs):
                self.assertEqual(args, ['node', '--version'])
                calls.append(args)
                raise host.GateError('ADMITTED_SOURCE_BOUNDARY')
            with patch.object(host, 'ROOT', root), patch.object(host, 'require_tool',
                    side_effect=lambda tool: tool), patch.object(host, 'run_bounded',
                    side_effect=boundary), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(host.GateError,
                        '^' + ('SOURCE_PRESERVATION' if corrupt else 'ADMITTED_SOURCE_BOUNDARY') + '$'):
                    host.main()
            self.assertEqual(len(calls), 0 if corrupt else 1)
            summary = json.loads(next(root.glob('artifacts/*/summary.json')).read_text())
            self.assertEqual(summary['status'], 'failed')
            self.assertTrue(summary['owned_cleanup_complete'])
            self.assertEqual(summary.get('ownership_intents', {}), {})
            self.assertEqual(summary.get('removed_owned_resources', {}), {})

    def test_all_native_callers_admit_exact_approved_source_before_allocation(self):
        for name in SCRIPTS:
            with self.subTest(script=name):
                self.check(name, False)

    def test_all_native_snapshots_detect_changes_to_every_new_control_dependency(self):
        sys.path.insert(0, str(ROOT / 'tools/fix-session'))
        from gate import GateError, input_identity, require_same_inputs
        dependencies = [
            'tools/fix-session/preservation-v4.json',
            'tools/fix-session/preservation-v3-source.zip',
            'tools/fix-session/preservation_v4.py',
            'tools/fix-session/preservation_v4_controls.py',
            'tests/preservation-v4/test_v4_controls.py',
            'tests/preservation-v4-callers/test_v4_callers.py',
        ]
        for script in SCRIPTS:
            with self.subTest(script=script), tempfile.TemporaryDirectory() as directory:
                root = self.fixture(directory)
                names = [
                    'package.json', 'package-lock.json', 'scripts/test-fix-session.py',
                    'scripts/test-fix-session.ts', 'scripts/verify-fix-session-compatibility.ts',
                    'verification/vendor/quickfix/FIX44.xml', 'tools/fix-session/Dockerfile.dockerignore',
                    'tools/fix-session/java/pom.xml', 'scripts/test-fix-live-application.py',
                    'scripts/verify-posttrade-journey.py', *dependencies,
                ]
                for name in names:
                    target = root / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes((ROOT / name).read_bytes())
                tree = ast.parse((ROOT / 'scripts' / script).read_text())
                main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'main')
                function = next(n for n in main.body if isinstance(n, ast.FunctionDef) and
                                n.name in ('source_inputs', 'inputs'))
                def inventory(args, **kwargs):
                    self.assertEqual(args, ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'])
                    self.assertEqual(kwargs, {'cwd': root})
                    return ('\0'.join(p.relative_to(root).as_posix() for p in root.rglob('*')
                                      if p.is_file() or p.is_symlink()) + '\0').encode()
                namespace = {'ROOT': root, 'Path': Path, 'input_identity': self.host(script).input_identity,
                             'subprocess': SimpleNamespace(check_output=inventory)}
                exec(compile(ast.Module(body=[function], type_ignores=[]), 'actual-input-inventory', 'exec'), namespace)
                inputs = namespace[function.name]
                for name in dependencies:
                    with self.subTest(dependency=name):
                        before = inputs()
                        target = root / name
                        original = target.read_bytes()
                        try:
                            target.write_bytes(original + b'changed after snapshot')
                            with self.assertRaisesRegex(GateError, '^SOURCE_CHANGED_DURING_GATE$'):
                                require_same_inputs(before, inputs())
                        finally:
                            target.write_bytes(original)
                # Same bytes behind a redirected leaf or parent must not be admitted.
                for name in dependencies:
                    target = root / name
                    shadow = target.with_suffix('.shadow')
                    before = inputs()
                    target.rename(shadow)
                    target.symlink_to(shadow)
                    try:
                        with self.assertRaisesRegex(GateError, '^INPUT_PATHS$'):
                            require_same_inputs(before, inputs())
                    finally:
                        target.unlink()
                        shadow.rename(target)
                for name in ['tests/preservation-v4', 'tests/preservation-v4-callers']:
                    target = root / name
                    shadow = target.with_name(target.name + '-shadow')
                    before = inputs()
                    target.rename(shadow)
                    target.symlink_to(shadow, target_is_directory=True)
                    try:
                        with self.assertRaisesRegex(GateError, '^INPUT_PATHS$'):
                            require_same_inputs(before, inputs())
                    finally:
                        target.unlink()
                        shadow.rename(target)

    def test_all_native_callers_reject_an_unapproved_original_before_commands(self):
        for name in SCRIPTS:
            with self.subTest(script=name):
                self.check(name, True)

if __name__ == '__main__':
    unittest.main()
