"""Native entry points must admit only the approved current source before allocating."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
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
        spec = importlib.util.spec_from_file_location('v3_caller_' + name.replace('-', '_'),
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

    def test_all_native_callers_reject_an_unapproved_original_before_commands(self):
        for name in SCRIPTS:
            with self.subTest(script=name):
                self.check(name, True)

if __name__ == '__main__':
    unittest.main()
