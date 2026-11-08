"""Strict, source-bound admission for mandatory preservation controls."""
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools/fix-session'))
from gate import GateError, admit_results

def _flatten(suite):
    for test in suite:
        if isinstance(test, unittest.TestSuite):
            yield from _flatten(test)
        else:
            yield test

class ControlResult(unittest.TextTestResult):
    """Outer gate bounds the complete host suite; no peer-only signal timer."""
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.outcomes = {}
    def addSuccess(self, test):
        super().addSuccess(test); self.outcomes[test.id()] = 'passed'
    def addFailure(self, test, error):
        super().addFailure(test, error); self.outcomes[test.id()] = 'failed'
    def addError(self, test, error):
        super().addError(test, error); self.outcomes[test.id()] = 'error'
    def addSkip(self, test, reason):
        super().addSkip(test, reason); self.outcomes[test.id()] = 'skipped'
    def addExpectedFailure(self, test, error):
        super().addExpectedFailure(test, error); self.outcomes[test.id()] = 'expected-failure'
    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test); self.outcomes[test.id()] = 'unexpected-success'

PRESERVATION = tuple('test_controls.PreservationV2.' + name for name in (
    'test_any_other_original_file_change_is_still_rejected',
    'test_either_approved_replacement_is_bound_to_its_exact_bytes',
    'test_mid_run_contract_changes_are_not_same_inputs',
    'test_missing_versioned_contract_cannot_fall_back',
    'test_modified_replacement_hash_or_new_exception_cannot_self_approve',
    'test_only_two_literal_approved_hashes_replace_the_original_map',
    'test_original_manifest_cannot_be_rewritten_to_accept_new_bytes',
    'test_symlinked_contract_or_baseline_is_rejected',
))
ADMISSION = tuple('test_admission.AdmissionTests.' + name for name in (
    'test_exact_successful_discovery_is_admitted',
    'test_missing_extra_duplicate_or_empty_control_cannot_pass',
    'test_skip_expected_failure_and_unexpected_success_are_denied',
    'test_incomplete_count_or_unsuccessful_run_is_denied',
    'test_missing_nonpass_extra_outcomes_and_forged_receipts_are_denied',
))
CONTROL_RECEIPT = {
    'version': 1, 'scope': 'phase4a-preservation-controls-v2',
    'preservation_controls': 8, 'admission_controls': 5, 'passed': 13,
    'failures': 0, 'errors': 0, 'skipped': 0, 'expected_failures': 0,
    'unexpected_successes': 0,
}

def admit_control_results(expected, discovered, outcomes, tests_run, successful,
                          skipped, expected_failures, unexpected_successes):
    try:
        expected, discovered = tuple(expected), tuple(discovered)
        if (not expected or len(expected) != len(set(expected)) or
                len(discovered) != len(expected) or set(discovered) != set(expected) or
                len(discovered) != len(set(discovered)) or
                set(outcomes) != set(expected) or type(tests_run) is not int or
                tests_run != len(expected) or successful is not True or
                any(type(value) is not int or value != 0 for value in
                    (skipped, expected_failures, unexpected_successes))):
            raise GateError('PRESERVATION_CONTROL_ADMISSION')
        admit_results({name: [name] for name in expected}, list(discovered), outcomes)
    except (GateError, TypeError, ValueError):
        raise GateError('PRESERVATION_CONTROL_ADMISSION') from None

def admit_control_receipt(text):
    try:
        if not isinstance(text, str):
            raise ValueError()
        receipt = json.loads(text.splitlines()[-1])
        if (not isinstance(receipt, dict) or set(receipt) != set(CONTROL_RECEIPT) or
                any(type(receipt[key]) is not type(value) or receipt[key] != value
                    for key, value in CONTROL_RECEIPT.items())):
            raise ValueError()
    except (ValueError, TypeError, IndexError):
        raise GateError('PRESERVATION_CONTROL_ADMISSION') from None

def _execute(directory, expected):
    suite = unittest.TestLoader().discover(str(ROOT / directory))
    discovered = tuple(test.id() for test in _flatten(suite))
    if len(discovered) != len(expected) or set(discovered) != set(expected):
        raise GateError('PRESERVATION_CONTROL_ADMISSION')
    result = unittest.TextTestRunner(stream=sys.stdout, verbosity=1, resultclass=ControlResult).run(suite)
    admit_control_results(expected, discovered, result.outcomes, result.testsRun,
                          result.wasSuccessful(), len(result.skipped),
                          len(result.expectedFailures), len(result.unexpectedSuccesses))
    return result.testsRun

def main():
    if (len(PRESERVATION) != CONTROL_RECEIPT['preservation_controls'] or
            len(ADMISSION) != CONTROL_RECEIPT['admission_controls']):
        raise GateError('PRESERVATION_CONTROL_ADMISSION')
    count = _execute('tests/preservation-admission', ADMISSION)
    count += _execute('tests/preservation-v2', PRESERVATION)
    if count != CONTROL_RECEIPT['passed']:
        raise GateError('PRESERVATION_CONTROL_ADMISSION')
    print(json.dumps(CONTROL_RECEIPT, sort_keys=True), flush=True)

if __name__ == '__main__':
    try:
        main()
    except GateError as error:
        print('PRESERVATION_CONTROLS_FAILED ' + str(error), file=sys.stderr, flush=True)
        raise SystemExit(1)
