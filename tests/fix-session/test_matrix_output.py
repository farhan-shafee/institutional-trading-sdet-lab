"""Progress must never prefix or split an evidence JSON record."""
import contextlib
import importlib.util
import io
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[2]
class MatrixOutputTests(unittest.TestCase):
    def test_receipt_starts_on_its_own_line_with_visible_case_progress(self):
        spec=importlib.util.spec_from_file_location('output_matrix',ROOT/'tools/fix-session/run_matrix.py')
        matrix=importlib.util.module_from_spec(spec);spec.loader.exec_module(matrix)
        class Probe(unittest.TestCase):
            def runTest(self):print('LAB_RECEIPT\t{"scope":"log-boundary-control"}',flush=True)
        probe=Probe();output=io.StringIO()
        with contextlib.redirect_stdout(output):
            result=unittest.TextTestRunner(stream=output,verbosity=2,resultclass=matrix.MatrixResult).run(unittest.TestSuite([probe]))
        self.assertTrue(result.wasSuccessful())
        lines=output.getvalue().splitlines()
        self.assertIn('LAB_RECEIPT\t{"scope":"log-boundary-control"}',lines)
        self.assertIn('CASE_START\t'+probe.id(),lines)
        self.assertIn('CASE_END\t'+probe.id()+'\tpassed',lines)

if __name__=='__main__':unittest.main()
