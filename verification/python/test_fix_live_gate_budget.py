"""Host accounting controls against the actual live gate implementation."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / "scripts/test-fix-live-application.py"
SPEC = importlib.util.spec_from_file_location("live_application_gate_budget", SOURCE)
GATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATE)


class EvidenceBudgetTests(unittest.TestCase):
    def test_regular_tree_counts_all_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "nested").mkdir()
            (root / "first").write_bytes(b"abc")
            (root / "nested/second").write_bytes(b"12345")
            self.assertEqual(GATE.evidence_bytes(root), 8)

    def test_vanished_entry_is_not_an_unsafe_retained_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entry = root / "record.json"
            entry.write_bytes(b"retained")
            walked = list(os.walk(root))
            entry.unlink()
            with patch.object(GATE.os, "walk", return_value=iter(walked)):
                self.assertEqual(GATE.evidence_bytes(root), 0)

    def test_unlinked_regular_inode_still_counts_its_observed_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entry = root / "record.json"
            payload = b"owned synthetic evidence"
            entry.write_bytes(payload)
            walked = list(os.walk(root))
            with entry.open("rb") as retained:
                entry.unlink()
                retired = os.fstat(retained.fileno())
                self.assertEqual(retired.st_nlink, 0)
                # Reproduce lookup acquiring the inode before unlink and stat
                # reading its metadata afterward, using a real unlinked inode.
                with patch.object(GATE.os, "walk", return_value=iter(walked)), patch.object(
                    GATE.Path, "lstat", return_value=retired
                ):
                    self.assertEqual(GATE.evidence_bytes(root), len(payload))

    def test_external_hard_link_remains_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entry = root / "record.json"
            entry.write_bytes(b"retained")
            os.link(entry, root / "alias.json")
            with self.assertRaisesRegex(GATE.GateError, "^EVIDENCE_PATH$"):
                GATE.evidence_bytes(root)

    def test_symlink_directories_symlink_files_and_fifo_remain_rejected(self):
        for kind in ("directory-link", "file-link", "fifo"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory) / "owned"
                root.mkdir()
                target = Path(directory) / "target"
                if kind == "directory-link":
                    target.mkdir()
                    (root / "unsafe").symlink_to(target, target_is_directory=True)
                elif kind == "file-link":
                    target.write_bytes(b"outside")
                    (root / "unsafe").symlink_to(target)
                else:
                    os.mkfifo(root / "unsafe", 0o600)
                with self.assertRaisesRegex(GATE.GateError, "^EVIDENCE_PATH$"):
                    GATE.evidence_bytes(root)
