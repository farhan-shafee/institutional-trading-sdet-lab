"""Admission must reject missing, skipped, and unsuccessful control receipts."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
RECEIPT = {'version': 1, 'scope': 'phase4a-preservation-controls-v2', 'preservation_controls': 8, 'admission_controls': 5, 'passed': 13, 'failures': 0, 'errors': 0, 'skipped': 0, 'expected_failures': 0, 'unexpected_successes': 0}
sys.path.insert(0, str(ROOT / 'tools/fix-session'))

class AdmissionTests(unittest.TestCase):
    def setUp(self):
        path = ROOT / 'tools/fix-session/preservation_controls.py'
        self.assertTrue(path.is_file(), 'Strict preservation admission is missing.')
        spec = importlib.util.spec_from_file_location('strict_preservation_admission', path)
        self.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.m)
        self.expected = ('fixture.alpha', 'fixture.beta')
        self.outcomes = {'fixture.alpha': 'passed', 'fixture.beta': 'passed'}

    def admit(self, **changes):
        values = dict(expected=self.expected, discovered=self.expected, outcomes=self.outcomes,
                      tests_run=2, successful=True, skipped=0, expected_failures=0,
                      unexpected_successes=0)
        values.update(changes)
        return self.m.admit_control_results(**values)

    def test_exact_successful_discovery_is_admitted(self):
        self.admit()
        self.m.admit_control_receipt('diagnostics\n' + json.dumps(RECEIPT))

    def test_missing_extra_duplicate_or_empty_control_cannot_pass(self):
        for names in [('fixture.alpha',), ('fixture.alpha', 'fixture.beta', 'fixture.gamma'),
                      ('fixture.alpha', 'fixture.alpha'), ()]:
            with self.subTest(names=names), self.assertRaisesRegex(self.m.GateError, '^PRESERVATION_CONTROL_ADMISSION$'):
                self.admit(discovered=names)
        with self.assertRaisesRegex(self.m.GateError, '^PRESERVATION_CONTROL_ADMISSION$'):
            self.admit(expected=(), discovered=(), outcomes={}, tests_run=0)

    def test_skip_expected_failure_and_unexpected_success_are_denied(self):
        for field in ['skipped', 'expected_failures', 'unexpected_successes']:
            with self.subTest(field=field), self.assertRaisesRegex(self.m.GateError, '^PRESERVATION_CONTROL_ADMISSION$'):
                self.admit(**{field: 1})

    def test_incomplete_count_or_unsuccessful_run_is_denied(self):
        for count in [0, 1, 3, True]:
            with self.subTest(count=count), self.assertRaisesRegex(self.m.GateError, '^PRESERVATION_CONTROL_ADMISSION$'):
                self.admit(tests_run=count)
        for status in [False, 1, None]:
            with self.subTest(status=status), self.assertRaisesRegex(self.m.GateError, '^PRESERVATION_CONTROL_ADMISSION$'):
                self.admit(successful=status)

    def test_missing_nonpass_extra_outcomes_and_forged_receipts_are_denied(self):
        for outcomes in [{'fixture.alpha': 'passed'},
                         {'fixture.alpha': 'passed', 'fixture.beta': 'skipped'},
                         {'fixture.alpha': 'passed', 'fixture.beta': 'failed'},
                         {**self.outcomes, 'fixture.gamma': 'passed'}]:
            with self.subTest(outcomes=outcomes), self.assertRaisesRegex(self.m.GateError, '^PRESERVATION_CONTROL_ADMISSION$'):
                self.admit(outcomes=outcomes)
        for text in ['', '{}', json.dumps({**RECEIPT, 'preservation_controls': 7}),
                     json.dumps({**RECEIPT, 'skipped': 8}),
                     json.dumps({**RECEIPT, 'version': True})]:
            with self.subTest(receipt=text), self.assertRaisesRegex(self.m.GateError, '^PRESERVATION_CONTROL_ADMISSION$'):
                self.m.admit_control_receipt(text)

if __name__ == '__main__':
    unittest.main()
