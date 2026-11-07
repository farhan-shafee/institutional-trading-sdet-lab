"""Gate failure controls use real subprocesses and literal missing inputs."""
import importlib.util
from pathlib import Path
import sys
import contextlib
import io
import json
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
def gate():
    path=ROOT/'tools/fix-session/gate.py'
    spec=importlib.util.spec_from_file_location('test_session_gate',path)
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

class GateControls(unittest.TestCase):
    def test_daemon_logging_cannot_write_outside_the_evidence_budget(self):
        m=gate();m.admit_log_driver({'Type':'none','Config':{}})
        for value in [{'Type':'json-file','Config':{}},{'Type':'local','Config':{}},{'Type':'fluentd','Config':{}},{}]:
            with self.subTest(value=value),self.assertRaisesRegex(m.GateError,'^RUNTIME_LOG_BUDGET$'):m.admit_log_driver(value)

    def test_empty_missing_case_and_missing_expectation_cannot_pass_admission(self):
        m=gate()
        import json
        manifest=json.loads((ROOT/'test-data/fix44/runtime/manifest.json').read_text())
        contract=json.loads((ROOT/'contracts/fix-session-runtime-v1.json').read_text())
        self.assertEqual(len(m.admit_manifest(manifest,contract)),43)
        for altered in [dict(manifest,cases=[]),dict(manifest,cases=manifest['cases'][:-1]),dict(manifest,cases=[dict(c,expected=[]) if i==0 else c for i,c in enumerate(manifest['cases'])])]:
            with self.assertRaises(m.GateError):m.admit_manifest(altered,contract)

    def test_changed_literal_expectation_and_profile_limit_are_denied(self):
        m=gate()
        manifest=json.loads((ROOT/'test-data/fix44/runtime/manifest.json').read_text())
        contract=json.loads((ROOT/'contracts/fix-session-runtime-v1.json').read_text())
        changed=json.loads(json.dumps(manifest));changed['cases'][0]['expected'][0]='logon-java=999'
        with self.subTest(kind='expectation'),self.assertRaisesRegex(m.GateError,'^CASE_EXPECTATION$'):m.admit_manifest(changed,contract)
        changed=json.loads(json.dumps(contract));changed['limits']['cpu']=2
        with self.subTest(kind='profile'),self.assertRaisesRegex(m.GateError,'^CASE_PROFILE$'):m.admit_manifest(manifest,changed)

    def test_missing_tool_and_wrong_pins_are_fixed_failures(self):
        m=gate()
        with self.assertRaisesRegex(m.GateError,'^MISSING_TOOL$'):m.require_tool('tradeflow-deliberately-missing-executable')
        with self.assertRaisesRegex(m.GateError,'^PIN_IDENTITY$'):m.admit_pins({'version':1},'')

    def test_frozen_authoring_reference_hash_cannot_drift(self):
        m=gate()
        import json
        lock=json.loads((ROOT/'tools/fix-session/dependencies.lock.json').read_text())
        dockerfile=(ROOT/'tools/fix-session/Dockerfile').read_text()
        m.admit_pins(lock,dockerfile)
        lock['references'][0]['sha256']='0'*64
        with self.assertRaisesRegex(m.GateError,'^PIN_IDENTITY$'):m.admit_pins(lock,dockerfile)

    def test_nonzero_deadline_and_output_overflow_are_not_success(self):
        m=gate()
        with tempfile.TemporaryDirectory() as d:
            for name,code,limit,expected in [('exit','raise SystemExit(7)',5,'CHILD_NONZERO'),('deadline','import threading;threading.Event().wait(30)',.1,'CHILD_DEADLINE'),('output','print("x"*65536)',5,'CHILD_OUTPUT_BUDGET')]:
                with self.subTest(name=name),self.assertRaisesRegex(m.GateError,'^'+expected+'$'):
                    m.run_bounded([sys.executable,'-c',code],Path(d)/(name+'.log'),limit,max_bytes=32768)

    def test_test_discovery_and_result_must_cover_bound_ids(self):
        m=gate();binding={'S01-01':['test_mod.Case.test_real']}
        with self.assertRaisesRegex(m.GateError,'^CASE_DISCOVERY$'):m.admit_results(binding,[],{})
        with self.assertRaisesRegex(m.GateError,'^CASE_RESULT$'):m.admit_results(binding,['test_mod.Case.test_real'],{'test_mod.Case.test_real':'skipped'})
        self.assertEqual(m.admit_results(binding,['test_mod.Case.test_real'],{'test_mod.Case.test_real':'passed'}),['S01-01'])

    def test_preservation_hash_cannot_accept_changed_original(self):
        m=gate()
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'original';p.write_text('changed')
            with self.assertRaisesRegex(m.GateError,'^SOURCE_PRESERVATION$'):m.verify_preserved(Path(d),{'original':'0'*64})

    def test_build_inputs_are_frozen_and_mid_run_changes_are_denied(self):
        m=gate()
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'peer.go').write_text('candidate one')
            before=m.input_identity(root,['peer.go'])
            m.require_same_inputs(before,m.input_identity(root,['peer.go']))
            (root/'peer.go').write_text('candidate two')
            with self.assertRaisesRegex(m.GateError,'^SOURCE_CHANGED_DURING_GATE$'):m.require_same_inputs(before,m.input_identity(root,['peer.go']))
            with self.assertRaisesRegex(m.GateError,'^INPUT_PATHS$'):m.input_identity(root,['../outside'])

    def test_missing_host_tool_retains_a_failed_summary_without_running_commands(self):
        spec=importlib.util.spec_from_file_location('host_session_gate',ROOT/'scripts/test-fix-session.py')
        host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)
        with tempfile.TemporaryDirectory() as d,patch.object(host,'ROOT',Path(d)),patch.object(host,'require_tool',side_effect=host.GateError('MISSING_TOOL')),patch.object(host,'run_bounded') as run,contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(host.GateError,'^MISSING_TOOL$'):host.main()
            summaries=list(Path(d).rglob('summary.json'))
            self.assertEqual(len(summaries),1)
            summary=json.loads(summaries[0].read_text())
            self.assertEqual(summary['status'],'failed');self.assertEqual(summary['error'],'MISSING_TOOL')
            run.assert_not_called()

if __name__=='__main__':unittest.main()
