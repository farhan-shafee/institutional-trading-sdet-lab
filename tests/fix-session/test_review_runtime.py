"""Actual fresh-object deleted-store admission reproduction."""
import contextlib
import importlib.util
import io
from pathlib import Path
import shutil
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
class ReviewRuntime(unittest.TestCase):
    def test_existing_identity_cannot_recreate_deleted_peer_store_in_a_new_lab(self):
        spec=importlib.util.spec_from_file_location('review_runtime_driver',ROOT/'tools/fix-session/runtime/driver.py')
        m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        with tempfile.TemporaryDirectory(dir='/state') as d:
            root=Path(d);first=m.Lab(root)
            with first:first.start()
            identity=first.identity;shutil.rmtree(root/'go')
            with self.assertRaisesRegex(ValueError,'^STORE_MISSING$'):
                with m.Lab(root,identity) as reopened:reopened.spawn('go')
            self.assertFalse((root/'go').exists())

if __name__=='__main__':unittest.main()
