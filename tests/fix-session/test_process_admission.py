import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
class ProcessAdmissionTests(unittest.TestCase):
    def test_unknown_role_is_rejected_before_creating_paths_or_processes(self):
        spec=importlib.util.spec_from_file_location('admission_driver',ROOT/'tools/fix-session/runtime/driver.py')
        m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        with tempfile.TemporaryDirectory() as d:
            lab=m.Lab(Path(d))
            for role in ['other','../other']:
                with self.assertRaisesRegex(m.LabError,'^STORE_ROLE$'):lab.spawn(role)
            self.assertEqual(list(Path(d).iterdir()),[])

    def test_known_role_requires_owned_run_before_starting_a_child(self):
        spec=importlib.util.spec_from_file_location('unowned_driver',ROOT/'tools/fix-session/runtime/driver.py')
        m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        with tempfile.TemporaryDirectory() as d:
            lab=m.Lab(Path(d))
            with self.assertRaisesRegex(m.LabError,'^RUN_NOT_OWNED$'):lab.spawn('go')
            self.assertEqual(list(Path(d).iterdir()),[])

if __name__=='__main__':unittest.main()
