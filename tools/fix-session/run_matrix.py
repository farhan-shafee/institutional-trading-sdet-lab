"""Execute all discovered controls once, recording every outcome explicitly."""
import json
from pathlib import Path
import signal
import sys
import unittest
from gate import GateError,admit_manifest,admit_results

ROOT=Path(__file__).resolve().parents[2]
def flatten(suite):
    for test in suite:
        if isinstance(test,unittest.TestSuite):yield from flatten(test)
        else:yield test

class MatrixResult(unittest.TextTestResult):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs);self.outcomes={};self.showAll=False;self.dots=False
    def startTest(self,test):
        super().startTest(test)
        print('CASE_START\t'+test.id(),flush=True)
        signal.setitimer(signal.ITIMER_REAL,150 if test.__class__.__module__.startswith('test_timer') else 60)
    def stopTest(self,test):
        signal.setitimer(signal.ITIMER_REAL,0);super().stopTest(test)
        print('CASE_END\t'+test.id()+'\t'+self.outcomes.get(test.id(),'incomplete'),flush=True)
    def addSuccess(self,test):super().addSuccess(test);self.outcomes[test.id()]='passed'
    def addFailure(self,test,error):super().addFailure(test,error);self.outcomes[test.id()]='failed'
    def addError(self,test,error):super().addError(test,error);self.outcomes[test.id()]='error'
    def addSkip(self,test,reason):super().addSkip(test,reason);self.outcomes[test.id()]='skipped'
    def addExpectedFailure(self,test,error):super().addExpectedFailure(test,error);self.outcomes[test.id()]='expected-failure'
    def addUnexpectedSuccess(self,test):super().addUnexpectedSuccess(test);self.outcomes[test.id()]='unexpected-success'

def main():
    # One stream preserves JSON receipt boundaries alongside progress/errors.
    sys.stderr=sys.stdout
    def expired(*unused):raise TimeoutError('SCENARIO_DEADLINE')
    signal.signal(signal.SIGALRM,expired)
    manifest=json.loads((ROOT/'test-data/fix44/runtime/manifest.json').read_text())
    contract=json.loads((ROOT/'contracts/fix-session-runtime-v1.json').read_text())
    ids=admit_manifest(manifest,contract)
    bindings=json.loads((ROOT/'test-data/fix44/runtime/bindings.json').read_text())
    if set(bindings)!=set(ids):raise GateError('CASE_BINDINGS')
    suite=unittest.defaultTestLoader.discover(str(ROOT/'tests/fix-session'))
    discovered=[test.id() for test in flatten(suite)]
    runtime_bindings={key:[name for name in values if not name.startswith('host:')] for key,values in bindings.items()}
    runtime_bindings={key:values for key,values in runtime_bindings.items() if values}
    if not discovered:raise GateError('CASE_DISCOVERY')
    result=unittest.TextTestRunner(stream=sys.stdout,verbosity=0,resultclass=MatrixResult).run(suite)
    report={'discovered':discovered,'outcomes':result.outcomes,'tests_run':result.testsRun,'successful':result.wasSuccessful()}
    print('MATRIX_RESULT\t'+json.dumps(report,sort_keys=True),flush=True)
    if not result.wasSuccessful() or result.testsRun!=len(discovered):raise GateError('CASE_RESULT')
    admit_results(runtime_bindings,discovered,result.outcomes)

if __name__=='__main__':main()
