"""Verify actual pinned libraries and test-only calendar/guard build proofs."""
import hashlib
import json
import os
import re
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[2]
class EnvironmentTests(unittest.TestCase):
    def test_compiled_go_dependencies_retain_exact_license_bytes(self):
        root=Path('/opt/runtime/licenses')
        inventory=json.loads((root/'go-dependencies.json').read_text())
        self.assertEqual(inventory['go_version'],'go1.27.3')
        self.assertEqual(inventory['modules']['github.com/quickfixgo/quickfix']['version'],'v0.9.12')
        core=inventory['modules']['github.com/quickfixgo/quickfix']['license_files']
        self.assertTrue(any(inventory['files'][name]['sha256']=='cc71f1162f710e93f9d9bd4c0a65396ac09e108706706c7899b1304045d99523' for name in core))
        self.assertTrue(inventory['files'])
        for name,entry in inventory['files'].items():
            data=(root/name).read_bytes()
            self.assertEqual(len(data),entry['bytes'])
            self.assertEqual(hashlib.sha256(data).hexdigest(),entry['sha256'])
        self.assertTrue(Path('/usr/share/doc/libstdc++6/copyright').is_file())

    def test_runtime_has_no_application_sdk_or_database_configuration(self):
        self.assertFalse((ROOT/'app').exists())
        self.assertFalse((ROOT/'node_modules').exists())
        self.assertFalse(any('DATABASE' in key or key.startswith('PG') for key in os.environ))
        self.assertFalse(Path('/var/run/docker.sock').exists())

    def test_actual_jars_and_dictionary_match_frozen_hashes(self):
        lock=json.loads((ROOT/'tools/fix-session/dependencies.lock.json').read_text())
        actual={path.name for path in Path('/opt/runtime/lib').iterdir()}
        self.assertEqual(actual,{entry['file'] for entry in lock['java_artifacts']})
        for entry in lock['java_artifacts']:
            data=(Path('/opt/runtime/lib')/entry['file']).read_bytes()
            self.assertEqual(len(data),entry['bytes']);self.assertEqual(hashlib.sha256(data).hexdigest(),entry['sha256'])
        self.assertEqual(hashlib.sha256((ROOT/'dictionary/FIX44.xml').read_bytes()).hexdigest(),'a82655b54363aa9c6d1b2f21f294f1198c0d7125d7b44c26d93d3179f3358425')

    def test_both_actual_engine_calendar_checks_and_guard_checks_ran(self):
        root=Path('/opt/runtime/proofs')
        for role,version in [('go','v0.9.12'),('java','3.0.2')]:
            text=(root/(role+'-calendar.txt')).read_text()
            self.assertIn('CALENDAR '+role+'='+version+' sender=7 target=9 day_boundaries=2 production_edits=0',text)
        self.assertEqual(len(re.findall(r'^--- PASS: Test', (root/'go-guard.txt').read_text(),re.MULTILINE)),9)
        self.assertEqual((root/'java-guard.txt').read_text().strip(),'Java response guard: 8 checks passed')

if __name__=='__main__':unittest.main()
