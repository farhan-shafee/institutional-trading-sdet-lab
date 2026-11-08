"""Gate failure controls use real subprocesses and literal missing inputs."""
import importlib.util
from pathlib import Path
import sys
import contextlib
import io
import hashlib
import json
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
def gate():
    path=ROOT/'tools/fix-session/gate.py'
    spec=importlib.util.spec_from_file_location('test_session_gate',path)
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

class GateControls(unittest.TestCase):
    def test_deadline_terminates_descendants_holding_output_and_retains_original_failure(self):
        m=gate()
        code='import subprocess,sys,time; subprocess.Popen([sys.executable,"-c","import time; time.sleep(8)"]); print("ready",flush=True); time.sleep(30)'
        with tempfile.TemporaryDirectory() as d:
            started=time.monotonic()
            try:m.run_bounded([sys.executable,'-c',code],Path(d)/'output.log',.5)
            except m.GateError as error:actual=str(error)
            else:self.fail('deadline accepted')
            self.assertEqual(actual,'CHILD_DEADLINE')
            self.assertLess(time.monotonic()-started,6)
            self.assertEqual((Path(d)/'output.log').read_text().strip(),'ready')

    def test_exited_parent_cannot_leave_a_descendant_holding_output_open(self):
        m=gate()
        code='import subprocess,sys; subprocess.Popen([sys.executable,"-c","import time; time.sleep(8)"]); print("parent-exited",flush=True)'
        with tempfile.TemporaryDirectory() as d:
            started=time.monotonic()
            with self.assertRaisesRegex(m.GateError,'^CHILD_OUTPUT_SHUTDOWN$'):
                m.run_bounded([sys.executable,'-c',code],Path(d)/'output.log',10)
            self.assertLess(time.monotonic()-started,6)

    def test_uncertain_daemon_creation_is_reconciled_by_owned_identity(self):
        # The CLI can fail after the daemon has accepted a build/create request.
        for fault in ('build','create','invalid-create'):
            with self.subTest(fault=fault):self.check_uncertain_creation(fault)

    def test_uncertain_creation_never_removes_a_resource_with_foreign_labels(self):
        self.check_uncertain_creation('create',foreign=True)

    def check_uncertain_creation(self,fault,foreign=False):
        spec=importlib.util.spec_from_file_location('uncertain_host_gate',ROOT/'scripts/test-fix-session.py')
        host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            for name in ['tools/fix-session/dependencies.lock.json','tools/fix-session/Dockerfile','test-data/fix44/runtime/manifest.json','test-data/fix44/runtime/bindings.json','contracts/fix-session-runtime-v1.json','tools/fix-session/preservation.json','tools/fix-session/preservation-v2.json','tools/fix-session/preservation_v2.py','tools/fix-session/preservation_controls.py']:
                target=root/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes((ROOT/name).read_bytes())
            lock_path=root/'tools/fix-session/dependencies.lock.json';lock=json.loads(lock_path.read_text())
            for name,key in [('go.mod','go_mod_sha256'),('go.sum','go_sum_sha256')]:
                target=root/'verification/fix-peer/go'/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(b'isolated daemon-boundary fixture\n')
                lock[key]=hashlib.sha256(target.read_bytes()).hexdigest()
            lock_path.write_text(json.dumps(lock))
            resources={};removed=[];identity=[]
            def run(args,path,*unused,**kwargs):
                text='';name=Path(path).stem
                if name=='preservation-v2-controls':
                    self.assertEqual(args,[sys.executable,'tools/fix-session/preservation_controls.py'])
                    text=json.dumps({'version':1,'scope':'phase4a-preservation-controls-v2','preservation_controls':8,'admission_controls':5,'passed':13,'failures':0,'errors':0,'skipped':0,'expected_failures':0,'unexpected_successes':0})+'\n'
                elif args[0]=='node':text='v24.22.0\n'
                elif args[1]=='build':
                    tag=args[args.index('-t')+1];run_id=tag.split('run-',1)[1];identity.append(run_id)
                    labels={'tradeflow.scope':'synthetic-fix-session','tradeflow.run_id':run_id}
                    resources['image']={'Id':'sha256:'+'a'*64,'Config':{'Labels':labels}}
                    if fault=='build':raise host.GateError('CHILD_DEADLINE')
                elif args[1]=='create':
                    labels={'tradeflow.scope':'synthetic-fix-session','tradeflow.run_id':'foreign' if foreign else identity[0]}
                    resources['container']={'Id':'b'*64,'Name':'/tradeflow-fix-session-'+identity[0],'Config':{'Labels':labels}}
                    if fault=='create':raise host.GateError('CHILD_DEADLINE')
                    text='not-a-container-id'
                elif args[1:3]==['image','inspect']:text=json.dumps([resources['image']])
                elif args[1]=='inspect':text=json.dumps([resources['container']])
                elif args[1]=='rm':
                    self.assertEqual(args[-1],resources['container']['Id']);removed.append('container')
                elif args[1:3]==['image','rm']:
                    self.assertEqual(args[-1],resources['image']['Id']);removed.append('image')
                elif args[1]!='version':self.fail('unexpected command '+repr(args))
                Path(path).write_text(text)
                return {'exit_code':0,'bytes':len(text)}
            def frozen_inputs(actual_root,paths):
                self.assertEqual(actual_root,root)
                for required in ['tools/fix-session/preservation.json','tools/fix-session/preservation-v2.json','tools/fix-session/preservation_v2.py','tools/fix-session/preservation_controls.py']:
                    self.assertIn(required,paths)
                return {'fixture':'immutable'}
            with patch.object(host,'ROOT',root),patch.object(host,'require_tool',side_effect=lambda name:name),patch.object(host,'verify_preserved'),patch.object(host,'input_identity',side_effect=frozen_inputs),patch.object(host,'run_bounded',side_effect=run),contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(host.GateError,'^'+('CONTAINER_ID' if fault=='invalid-create' else 'CHILD_DEADLINE')+'$'):host.main()
            summary=json.loads(next(root.rglob('summary.json')).read_text())
            self.assertEqual(summary['status'],'failed')
            self.assertEqual(summary['preserved_original_files'],432)
            self.assertEqual(summary['reviewed_replacements'],2)
            self.assertEqual(summary['preservation_version'],2)
            self.assertEqual(summary['error'],'CONTAINER_ID' if fault=='invalid-create' else 'CHILD_DEADLINE')
            self.assertIn('image',removed)
            if fault!='build' and not foreign:self.assertIn('container',removed)
            if foreign:
                self.assertNotIn('container',removed);self.assertFalse(summary['owned_cleanup_complete'])
                self.assertIn('CONTAINER_CLEANUP_UNRESOLVED',summary['cleanup_errors'])
            else:self.assertTrue(summary['owned_cleanup_complete'])
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
