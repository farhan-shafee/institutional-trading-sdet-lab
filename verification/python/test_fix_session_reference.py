"""Independent literal session cases and adversarial corpus controls; no sockets."""
from contextlib import contextmanager
from copy import deepcopy
import hashlib
import importlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
ROOT = HERE.parents[1]
MANIFEST = ROOT / "test-data/fix44/session/manifest.json"
CORPUS = json.loads(MANIFEST.read_text(encoding="utf-8"))
FRAMES = {
    path.name: path.read_bytes()
    for path in MANIFEST.parent.glob("*.fix")
}
try:
    session = importlib.import_module("fix_session_reference")
except ModuleNotFoundError as error:
    if error.name != "fix_session_reference":
        raise
    session = None

CLAIMS = dict(
    offline_conformance_only=True,
    peer_interoperability_verified=False,
    delivery_verified=False,
    financial_application_verified=False,
    external_completeness_verified=False,
)


@contextmanager
def copied_corpus():
    with tempfile.TemporaryDirectory(prefix="tf-session-test-") as directory:
        root = Path(directory)
        for path in MANIFEST.parent.iterdir():
            if path.is_file():
                shutil.copyfile(path, root / path.name)
        yield root / "manifest.json"


def write_manifest(path, data):
    path.write_text(json.dumps(data), encoding="utf-8")


def wire(pairs):
    """Test-only byte constructor; never calls the session checker or TS codec."""
    body = b"".join(str(k).encode() + b"=" + str(v).encode() + b"\x01" for k, v in pairs)
    prefix = b"8=FIX.4.4\x019=" + str(len(body)).encode() + b"\x01" + body
    return prefix + b"10=" + f"{sum(prefix) % 256:03}".encode() + b"\x01"


def logon_wire(extras=()):
    return wire([
        (35, "A"), (49, "TF3C_INITIATOR"), (56, "TF3C_ACCEPTOR"),
        (34, "1"), (52, "20261104-12:00:01.000"),
        (98, "0"), (108, "30"), *extras,
    ])


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(session, "offline session checker is not implemented")

    def test_complete_corpus_matches_literal_reports_in_order(self):
        reports = session.verify_corpus(MANIFEST)
        self.assertEqual(reports, [case["expected"] | CLAIMS for case in CORPUS["cases"]])

    def test_repeat_evaluation_does_not_mutate_inputs(self):
        case = deepcopy(CORPUS["cases"][5])
        before = deepcopy(case)
        a = session.evaluate_case(case, FRAMES)
        self.assertEqual(a, session.evaluate_case(case, FRAMES))
        self.assertEqual(case, before)
        self.assertEqual(set(a), set(case["expected"]) | set(CLAIMS))

    def invalid_corpus(self, change):
        with copied_corpus() as path:
            data = deepcopy(CORPUS)
            change(data)
            write_manifest(path, data)
            with self.assertRaises(session.CorpusError):
                session.verify_corpus(path)

    def test_zero_cases_cannot_be_accepted(self):
        self.invalid_corpus(lambda data: data.update(cases=[]))

    def test_unknown_root_case_event_and_expected_keys(self):
        for location in ("root", "case", "event", "expected"):
            with self.subTest(location=location):
                def change(data):
                    target = {"root": data, "case": data["cases"][0],
                              "event": data["cases"][0]["events"][0],
                              "expected": data["cases"][0]["expected"]}[location]
                    target["unknown"] = "NEVER_ACCEPT"
                self.invalid_corpus(change)

    def test_duplicate_json_keys_and_nonfinite_json_fail_closed(self):
        with copied_corpus() as path:
            text = path.read_text()
            for corrupt in (
                text.replace('"version":', '"version":"duplicate","version":', 1),
                text.replace('"next_i_to_a": 3', '"next_i_to_a": NaN', 1),
            ):
                with self.subTest(corrupt=corrupt[:20]):
                    path.write_text(corrupt)
                    with self.assertRaises(session.CorpusError):
                        session.verify_corpus(path)

    def test_duplicate_case_id(self):
        self.invalid_corpus(lambda data: data["cases"][1].update(id=data["cases"][0]["id"]))

    def test_expected_code_classification_pair_and_strict_types(self):
        for change in (
            {"code": "UNREVIEWED"}, {"classification": "CLEAN"},
            {"classification": "INVALID", "code": "COMPLETE"},
            {"next_i_to_a": True}, {"next_a_to_i": 1.0}, {"event_index": False},
            {"pending_i": "bad id"},
        ):
            with self.subTest(change=change):
                self.invalid_corpus(lambda data: data["cases"][0]["expected"].update(change))

    def test_end_is_exactly_once_and_last(self):
        for mode in ("missing", "middle", "duplicate"):
            def change(data):
                events = data["cases"][0]["events"]
                if mode == "missing":
                    events.pop()
                elif mode == "middle":
                    events.insert(1, events.pop())
                else:
                    events.append({"kind": "END"})
            with self.subTest(mode=mode):
                self.invalid_corpus(change)

    def test_invalid_direction_filename_hash_and_unknown_observation(self):
        for change in (
            {"direction": "BOTH"}, {"file": "../i_logon_1.fix"},
            {"file": "C:\\secret.fix"}, {"file": "UPPER.fix"},
            {"sha256": "0" * 63}, {"sha256": "A" * 64},
            {"kind": "UNKNOWN"},
        ):
            with self.subTest(change=change):
                self.invalid_corpus(lambda data: data["cases"][0]["events"][0].update(change))

    def test_missing_extra_and_changed_fixture(self):
        for mode in ("missing", "extra", "hash"):
            with copied_corpus() as path, self.subTest(mode=mode):
                target = path.parent / "i_logon_1.fix"
                if mode == "missing":
                    target.unlink()
                elif mode == "extra":
                    (path.parent / "unreferenced.fix").write_bytes(b"BAD")
                else:
                    target.write_bytes(target.read_bytes().replace(b"TF3C", b"OTHER", 1))
                with self.assertRaises(session.CorpusError):
                    session.verify_corpus(path)

    def test_hash_error_precedes_transcript_error(self):
        with copied_corpus() as path:
            (path.parent / "i_logon_1.fix").write_bytes(b"BROKEN_FRAME")
            with self.assertRaises(session.CorpusError):
                session.verify_corpus(path)

    def test_symbolic_fixture_and_manifest_are_rejected(self):
        if sys.platform == "win32":
            with copied_corpus() as path:
                junction = path.parent / "junction"
                made = subprocess.run(["cmd", "/c", "mklink", "/J", str(junction),
                                       str(path.parent)], capture_output=True, timeout=10)
                self.assertEqual(made.returncode, 0, "owned NTFS junction must be created")
                try:
                    with self.assertRaises(session.CorpusError):
                        session.verify_corpus(junction / path.name)
                finally:
                    junction.rmdir()
        else:
            with copied_corpus() as path:
                target = path.parent / "i_logon_1.fix"
                with tempfile.TemporaryDirectory(prefix="tf-session-external-") as directory:
                    outside = Path(directory) / "external.fix"
                    outside.write_bytes(target.read_bytes())
                    target.unlink()
                    target.symlink_to(outside)
                    with self.assertRaises(session.CorpusError):
                        session.verify_corpus(path)
            with copied_corpus() as path:
                real = path.parent / "real.json"
                path.rename(real)
                path.symlink_to(real)
                with self.assertRaises(session.CorpusError):
                    session.verify_corpus(path)

    def test_dictionary_tampering_after_first_use_fails_closed(self):
        with tempfile.TemporaryDirectory(prefix="tf-session-reference-") as directory:
            root = Path(directory)
            shutil.copytree(ROOT / "verification/python", root / "verification/python")
            shutil.copytree(ROOT / "verification/vendor", root / "verification/vendor")
            shutil.copytree(MANIFEST.parent, root / "test-data/fix44/session")
            code = (
                "import sys;from pathlib import Path;"
                "sys.path.insert(0," + repr(str(root / "verification/python")) + ");"
                "import fix_session_reference as s;"
                "p=Path(" + repr(str(root / "test-data/fix44/session/manifest.json")) + ");"
                "s.verify_corpus(p);"
                "d=Path(" + repr(str(root / "verification/vendor/quickfix/FIX44.xml")) + ");"
                "d.write_bytes(d.read_bytes()+b' ');"
                "\ntry:s.verify_corpus(p)"
                "\nexcept s.CorpusError:sys.exit(0)"
                "\nelse:sys.exit(3)"
            )
            result = subprocess.run([sys.executable, "-c", code],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_orphan_discovery_rejects_without_eager_enumeration(self):
        # A bounded hostile directory stream stands in for an otherwise enormous
        # real directory. The real verifier must reject its first orphan; no call
        # count or mock-only output is asserted. Eager allocation is the defect.
        class Entry:
            name = "orphan.fix"

        def entries():
            yield Entry()
            raise AssertionError("directory entries consumed beyond first orphan")

        @contextmanager
        def scan(_path):
            yield entries()

        with copied_corpus() as path:
            with patch("fix_session_reference.os.scandir", scan), patch(
                "fix_session_reference.os.listdir",
                side_effect=AssertionError("eager listdir allocation is forbidden"),
            ):
                with self.assertRaises(session.CorpusError):
                    session.verify_corpus(path)

    def test_manifest_byte_boundary(self):
        with copied_corpus() as path:
            raw = path.read_bytes()
            path.write_bytes(raw + b" " * (131072 - len(raw)))
            self.assertEqual(len(session.verify_corpus(path)), len(CORPUS["cases"]))
            with path.open("ab") as stream:
                stream.write(b" ")
            with self.assertRaises(session.CorpusError):
                session.verify_corpus(path)

    def test_case_and_event_boundaries(self):
        with copied_corpus() as path:
            data = deepcopy(CORPUS)
            # Fresh unique IDs exercise actual admission at 64, not a constant assertion.
            while len(data["cases"]) < 64:
                case = deepcopy(data["cases"][0])
                case["id"] = "C99_BOUND_" + str(len(data["cases"]))
                data["cases"].append(case)
            write_manifest(path, data)
            self.assertEqual(len(session.verify_corpus(path)), 64)
            extra = deepcopy(data["cases"][0]); extra["id"] = "C99_BOUND_OVER"
            data["cases"].append(extra); write_manifest(path, data)
            with self.assertRaises(session.CorpusError):
                session.verify_corpus(path)
        with copied_corpus() as path:
            data = deepcopy(CORPUS)
            data["cases"][0]["events"] = [
                *data["cases"][0]["events"][:-1],
                *([{"kind": "CONNECTION_LOST"}] * 28), {"kind": "END"},
            ]
            write_manifest(path, data)
            # Admitted, then deliberately mismatched expected report -> exit-1 class.
            with self.assertRaises(session.ExpectationMismatch):
                session.verify_corpus(path)
            data["cases"][0]["events"].insert(-1, {"kind": "CONNECTION_LOST"})
            write_manifest(path, data)
            with self.assertRaises(session.CorpusError):
                session.verify_corpus(path)

    def test_raw_file_and_unique_bytes_boundary(self):
        with copied_corpus() as path:
            data = deepcopy(CORPUS)
            target = path.parent / "i_logon_1.fix"
            target.write_bytes(b"x" * 8192)
            digest = hashlib.sha256(target.read_bytes()).hexdigest()
            for case in data["cases"]:
                for event in case["events"]:
                    if event.get("file") == target.name:
                        event["sha256"] = digest
            write_manifest(path, data)
            with self.assertRaises(session.ExpectationMismatch):
                session.verify_corpus(path)
            target.write_bytes(b"x" * 8193)
            with self.assertRaises(session.CorpusError):
                session.verify_corpus(path)
        with copied_corpus() as path:
            data = deepcopy(CORPUS)
            # Use an owned valid manifest with 33 unique 8192-byte inputs.
            for file in path.parent.glob("*.fix"):
                file.unlink()
            cases = []
            for index in range(33):
                name = f"bound_{index}.fix"; raw = b"x" * 8192
                (path.parent / name).write_bytes(raw)
                cases.append({
                    "id": f"C99_BYTES_{index}",
                    "events": [{"kind": "FRAME", "direction": "I_TO_A",
                                "file": name, "sha256": hashlib.sha256(raw).hexdigest()},
                               {"kind": "END"}],
                    "expected": dict(classification="INVALID", code="FRAME_INVALID",
                                     event_index=0, state="NEW", next_i_to_a=1,
                                     next_a_to_i=1, pending_i=None, pending_a=None),
                })
            write_manifest(path, dict(version=CORPUS["version"], cases=cases[:32]))
            (path.parent / "bound_32.fix").unlink()
            self.assertEqual(len(session.verify_corpus(path)), 32)
            (path.parent / "bound_32.fix").write_bytes(b"x" * 8192)
            write_manifest(path, dict(version=CORPUS["version"], cases=cases))
            with self.assertRaises(session.CorpusError):
                session.verify_corpus(path)

    def test_field_value_and_sequence_boundaries(self):
        template = deepcopy(CORPUS["cases"][6])
        for extras, want in (
            ([(9999, "x" * 256)], "MESSAGE_SCHEMA"),
            ([(9999, "x" * 257)], "FRAME_INVALID"),
        ):
            with self.subTest(want=want):
                frame = logon_wire(extras)
                template["events"] = [
                    {"kind": "FRAME", "direction": "I_TO_A", "file": "bound.fix",
                     "sha256": hashlib.sha256(frame).hexdigest()}, {"kind": "END"},
                ]
                self.assertEqual(session.evaluate_case(template, {"bound.fix": frame})["code"], want)
        for total, want in ((64, "MESSAGE_SCHEMA"), (65, "FRAME_INVALID")):
            frame = logon_wire([(8000 + i, "x") for i in range(total - 10)])
            template["events"][0]["sha256"] = hashlib.sha256(frame).hexdigest()
            self.assertEqual(session.evaluate_case(template, {"bound.fix": frame})["code"], want)

    def test_cli_mismatch_invalid_and_safe_diagnostics(self):
        checker = ROOT / "verification/python/fix_session_reference.py"
        with copied_corpus() as path:
            data = deepcopy(CORPUS)
            data["cases"][0]["expected"]["next_i_to_a"] = 4
            write_manifest(path, data)
            result = subprocess.run([sys.executable, str(checker), str(path)],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            path.write_text('{"private":"DO_NOT_PRINT_RAW_INPUT"}')
            result = subprocess.run([sys.executable, str(checker), str(path)],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 2)
            self.assertNotIn("DO_NOT_PRINT", result.stdout + result.stderr)
            self.assertNotIn(str(path), result.stdout + result.stderr)
            self.assertNotIn("Traceback", result.stdout + result.stderr)


def literal_case_test(case):
    def test(self):
        actual = session.evaluate_case(deepcopy(case), FRAMES)
        self.assertEqual(actual, case["expected"] | CLAIMS)
    return test


for literal_case in CORPUS["cases"]:
    setattr(SessionTests, "test_" + literal_case["id"], literal_case_test(literal_case))

if __name__ == "__main__":
    unittest.main()
