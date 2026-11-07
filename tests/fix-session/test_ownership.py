import importlib.util
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[2]
def module(test):
    path=ROOT/'tools/fix-session/runtime/ownership.py'
    test.assertTrue(path.is_file(),'owned runtime/store admission is not implemented')
    spec=importlib.util.spec_from_file_location('runtime_ownership',path)
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

class OwnershipTests(unittest.TestCase):
    def test_non_loopback_and_reset_configuration_denied(self):
        m=module(self)
        m.check_configuration('127.0.0.1',19876,19875,False)
        for args in [('0.0.0.0',19876,19875,False),('localhost',19876,19875,False),('127.0.0.1',19876,19875,True),('127.0.0.1',22,19875,False)]:
            with self.subTest(args=args),self.assertRaises(m.OwnershipError):m.check_configuration(*args)

    def test_existing_owner_cannot_be_replaced(self):
        m=module(self)
        with tempfile.TemporaryDirectory() as d:
            identity=str(uuid4())
            with m.StoreOwner(Path(d),identity):pass
            with m.StoreOwner(Path(d),identity):pass
            with self.assertRaises(m.OwnershipError):
                with m.StoreOwner(Path(d),str(uuid4())):pass

    def test_unowned_populated_directory_denied(self):
        m=module(self)
        with tempfile.TemporaryDirectory() as d:
            (Path(d)/'other-data').write_text('leave me')
            with self.assertRaises(m.OwnershipError):
                with m.StoreOwner(Path(d),str(uuid4())):pass
            self.assertEqual((Path(d)/'other-data').read_text(),'leave me')

    def test_second_writer_denied(self):
        m=module(self)
        with tempfile.TemporaryDirectory() as d:
            identity=str(uuid4())
            with m.StoreOwner(Path(d),identity):
                with self.assertRaises(m.OwnershipError):
                    with m.StoreOwner(Path(d),identity):pass

    def test_store_checkpoint_rejects_changed_or_missing_bytes(self):
        m=module(self)
        with tempfile.TemporaryDirectory() as d:
            with m.StoreOwner(Path(d),str(uuid4())) as owner:
                role=Path(d)/'java';role.mkdir();file=role/'session.seqnums';file.write_text('0000000002 : 0000000002')
                owner.checkpoint('java');owner.verify('java')
                file.write_text('0000000001 : 0000000001')
                with self.assertRaises(m.OwnershipError):owner.verify('java')
                file.unlink()
                with self.assertRaises(m.OwnershipError):owner.verify('java')

    def test_empty_store_cannot_be_checkpointed(self):
        m=module(self)
        with tempfile.TemporaryDirectory() as d:
            with m.StoreOwner(Path(d),str(uuid4())) as owner:
                (Path(d)/'go').mkdir()
                with self.assertRaises(m.OwnershipError):owner.checkpoint('go')

    def test_symbolic_store_components_denied(self):
        m=module(self)
        with tempfile.TemporaryDirectory() as d,tempfile.TemporaryDirectory() as external:
            with m.StoreOwner(Path(d),str(uuid4())) as owner:
                (Path(d)/'java').symlink_to(external,target_is_directory=True)
                with self.assertRaises(m.OwnershipError):owner.checkpoint('java')

    def test_unknown_role_and_budget_exhaustion_denied(self):
        m=module(self)
        with tempfile.TemporaryDirectory() as d:
            with m.StoreOwner(Path(d),str(uuid4())) as owner:
                with self.assertRaises(m.OwnershipError):owner.checkpoint('../other')
                with (Path(d)/'quota-control').open('wb') as f:f.truncate(64*1024*1024+1)
                with self.assertRaises(m.OwnershipError):owner.budget()

    def test_unreadable_store_directory_cannot_hide_owned_bytes(self):
        m=module(self)
        with tempfile.TemporaryDirectory() as d:
            with m.StoreOwner(Path(d),str(uuid4())) as owner:
                hidden=Path(d)/'go';hidden.mkdir();(hidden/'messages').write_text('persisted')
                hidden.chmod(0)
                try:
                    with self.assertRaises(m.OwnershipError):owner.budget()
                finally:hidden.chmod(0o700)

if __name__=='__main__':unittest.main()
