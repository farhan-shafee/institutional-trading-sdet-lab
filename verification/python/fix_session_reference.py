"""Bounded offline transcript classifier. Not a FIX engine, peer or financial adapter."""
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

from fix44_reference import Dictionary44, ProtocolError, parse_wire, timestamp

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = ROOT / "test-data/fix44/session/manifest.json"
CLAIMS = dict(offline_conformance_only=True, peer_interoperability_verified=False,
              delivery_verified=False, financial_application_verified=False,
              external_completeness_verified=False)
CODE_CLASS = {
    "COMPLETE": "IN_SCOPE_CONFORMANT",
    **dict.fromkeys(("FRAME_INVALID", "COMP_ID_MISMATCH", "MESSAGE_TYPE_UNKNOWN",
                     "MESSAGE_SCHEMA", "STATE_TRANSITION", "TEST_REQ_ID_MISMATCH",
                     "TEST_REQUEST_ALREADY_PENDING", "TEST_REQ_ID_REUSED",
                     "AFTER_CLOSED", "SEQUENCE_TOO_LOW"), "INVALID"),
    **dict.fromkeys(("PROFILE_OPTION_UNSUPPORTED", "RESET_UNSUPPORTED",
                     "RESEND_UNSUPPORTED", "SESSION_REJECT_UNSUPPORTED",
                     "MESSAGE_UNSUPPORTED", "REPLAY_UNSUPPORTED",
                     "RECOVERY_REQUIRED", "ERROR_LOGOUT_UNSUPPORTED",
                     "RECONNECT_UNSUPPORTED"), "OUT_OF_SCOPE"),
    **dict.fromkeys(("EMPTY_SESSION", "LOGON_REPLY_MISSING", "TEST_RESPONSE_MISSING",
                     "LOGOUT_MISSING", "LOGOUT_REPLY_MISSING", "CONNECTION_LOST"),
                    "INCOMPLETE"),
}
STATES = {"NEW", "LOGON_PENDING", "ESTABLISHED",
          "LOGOUT_PENDING_I", "LOGOUT_PENDING_A", "CLOSED"}
RESULT_KEYS = {"classification", "code", "event_index", "state",
               "next_i_to_a", "next_a_to_i", "pending_i", "pending_a"}
REQUEST_ID = re.compile(r"[A-Z0-9][A-Z0-9_-]{0,31}")
FILE_NAME = re.compile(r"[a-z0-9_-]{1,64}\.fix")
CASE_ID = re.compile(r"C[0-9]{2}_[A-Z0-9_]{1,48}")
HASH = re.compile(r"[a-f0-9]{64}")
HEADER = [8, 9, 35, 49, 56, 34, 43, 52, 122]
REQUIRED_HEADER = {8, 9, 35, 49, 56, 34, 52}
BODY = {"A": ({98, 108}, {98, 108, 141}), "0": (set(), {112}),
        "1": ({112}, {112}), "5": (set(), {58})}


class CorpusError(ValueError):
    """Corpus admission/reference failure; message is a fixed non-sensitive code."""


class ExpectationMismatch(ValueError):
    """A reviewed literal result differs from the observed classification."""


def require(condition):
    if not condition:
        raise CorpusError("CORPUS_INVALID")


def exact_object(value, keys):
    require(type(value) is dict and set(value) == set(keys))


def integer(value, lower, upper):
    return type(value) is int and lower <= value <= upper


def request_id(value):
    return type(value) is str and REQUEST_ID.fullmatch(value) is not None


def validate_case(case):
    exact_object(case, {"id", "events", "expected"})
    require(type(case["id"]) is str and CASE_ID.fullmatch(case["id"]) is not None)
    events = case["events"]
    require(type(events) is list and 1 <= len(events) <= 33)
    require(events[-1] == {"kind": "END"})
    for index, event in enumerate(events):
        require(type(event) is dict)
        kind = event.get("kind")
        if kind == "FRAME":
            exact_object(event, {"kind", "direction", "file", "sha256"})
            require(event["direction"] in ("I_TO_A", "A_TO_I"))
            require(type(event["file"]) is str and FILE_NAME.fullmatch(event["file"]) is not None)
            require(type(event["sha256"]) is str and HASH.fullmatch(event["sha256"]) is not None)
        else:
            exact_object(event, {"kind"})
            require(kind in ("CONNECTION_LOST", "RECONNECT_ATTEMPT", "END"))
            require((kind == "END") == (index == len(events) - 1))
    expected = case["expected"]
    exact_object(expected, RESULT_KEYS)
    require(type(expected["code"]) is str and expected["code"] in CODE_CLASS)
    require(expected["classification"] == CODE_CLASS[expected["code"]])
    require(type(expected["state"]) is str and expected["state"] in STATES)
    require(integer(expected["event_index"], 0, len(events) - 1))
    for key in ("next_i_to_a", "next_a_to_i"):
        require(integer(expected[key], 1, 2147483647))
    for key in ("pending_i", "pending_a"):
        require(expected[key] is None or request_id(expected[key]))


def regular_path(path):
    """Reject symlink/reparse components and nonregular inputs without resolving them."""
    current = Path(os.path.abspath(path))
    for item in (*reversed(current.parents), current):
        metadata = item.lstat()
        require(not stat.S_ISLNK(metadata.st_mode))
        require(not (getattr(metadata, "st_file_attributes", 0) &
                     getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)))
    require(stat.S_ISREG(metadata.st_mode))
    return current, metadata


def read_bounded(path, limit):
    path, before = regular_path(path)
    require(before.st_size <= limit)
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        require(stat.S_ISREG(opened.st_mode))
        require((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino))
        require(opened.st_size <= limit)
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            raw = stream.read(limit + 1)
        require(len(raw) <= limit)
        _, after = regular_path(path)
        require((after.st_dev, after.st_ino, after.st_size) ==
                (opened.st_dev, opened.st_ino, len(raw)))
        return raw
    finally:
        os.close(descriptor)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def reject_constant(_value):
    raise CorpusError("CORPUS_INVALID")


def load_manifest(path):
    try:
        raw = read_bounded(path, 131072)
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object,
                           parse_constant=reject_constant)
    except (OSError, UnicodeError, ValueError, RecursionError):
        raise CorpusError("CORPUS_INVALID") from None
    exact_object(value, {"version", "cases"})
    require(value["version"] == "tradeflow-fix-session-corpus-v1")
    require(type(value["cases"]) is list and 1 <= len(value["cases"]) <= 64)
    names = set()
    for case in value["cases"]:
        validate_case(case)
        require(case["id"] not in names)
        names.add(case["id"])
    return value


@lru_cache(maxsize=1)
def parsed_schema():
    try:
        dictionary = Dictionary44()
    except (OSError, ValueError):
        raise CorpusError("REFERENCE_INVALID") from None
    dictionary.messages = {node.attrib["msgtype"]: node
                           for node in dictionary.root.find("messages")}
    dictionary.header_tags = dictionary.expand(dictionary.root.find("header"))[0]
    return dictionary


def schema():
    # Pin each public evaluation, even when the parsed XML object is cached.
    references = (
        ("FIX44.xml", 524288,
         "a82655b54363aa9c6d1b2f21f294f1198c0d7125d7b44c26d93d3179f3358425"),
        ("LICENSE", 65536,
         "04719eefe7adf383d7970d7654caec6f7e542e6427f25d068e7177495fc9b379"),
    )
    try:
        for filename, bound, digest in references:
            raw = read_bounded(ROOT / "verification/vendor/quickfix" / filename, bound)
            if hashlib.sha256(raw).hexdigest() != digest:
                raise CorpusError("REFERENCE_INVALID")
    except OSError:
        raise CorpusError("REFERENCE_INVALID") from None
    return parsed_schema()


def primitive(definition, value):
    """Base dictionary primitive/enum check; no application-profile semantics."""
    enums = {item.attrib["enum"] for item in definition if item.tag == "value"}
    if enums and value not in enums:
        return False
    kind = definition.attrib["type"]
    if kind == "INT":
        return re.fullmatch(r"-?[0-9]+", value) is not None
    if kind in ("LENGTH", "NUMINGROUP", "SEQNUM", "DAYOFMONTH"):
        return re.fullmatch(r"[0-9]+", value) is not None
    if kind in ("PRICE", "QTY", "AMT", "FLOAT", "PRICEOFFSET", "PERCENTAGE"):
        return re.fullmatch(r"-?[0-9]+(?:\.[0-9]+)?", value) is not None
    if kind == "BOOLEAN":
        return value in ("Y", "N")
    if kind == "CHAR":
        return len(value) == 1
    if kind == "UTCTIMESTAMP":
        return valid_timestamp(value) is not None
    if kind in ("LOCALMKTDATE", "UTCDATEONLY"):
        try:
            from datetime import datetime
            return re.fullmatch(r"[0-9]{8}", value) is not None and bool(
                datetime.strptime(value, "%Y%m%d"))
        except ValueError:
            return False
    if kind == "CURRENCY":
        return re.fullmatch(r"[A-Z]{3}", value) is not None
    # Excluded DATA/groups have no supported structural-conformance claim.
    return kind in ("STRING", "EXCHANGE", "COUNTRY", "DATA", "MULTIPLEVALUESTRING",
                    "MULTIPLESTRINGVALUE", "MULTIPLECHARVALUE", "LANGUAGE")


def valid_timestamp(value):
    try:
        parsed = timestamp(value)
        return parsed if 1900 <= parsed.year <= 2199 else None
    except ProtocolError:
        return None


def inspect_frame(raw, direction, dictionary):
    try:
        fields = parse_wire(raw)
        tags = list(fields)
        if not REQUIRED_HEADER.issubset(fields):
            return "FRAME_INVALID", None
        projection = [tag for tag in tags if tag in HEADER]
        if projection != [tag for tag in HEADER if tag in fields]:
            return "FRAME_INVALID", None
        body_started = False
        body_tags = []
        extra_headers = set()
        for tag in tags[3:-1]:
            if tag in dictionary.header_tags:
                if body_started:
                    return "FRAME_INVALID", None
                if not primitive(dictionary.by_tag[tag], fields[tag]):
                    return "FRAME_INVALID", None
                if tag not in HEADER:
                    extra_headers.add(tag)
            else:
                body_started = True
                body_tags.append(tag)
        if not re.fullmatch(r"[1-9][0-9]{0,9}", fields[34]):
            return "FRAME_INVALID", None
        if int(fields[34]) > 2147483647:
            return "FRAME_INVALID", None
        if valid_timestamp(fields[52]) is None:
            return "FRAME_INVALID", None
        if fields.get(43) == "Y":
            if 122 not in fields or valid_timestamp(fields[122]) is None:
                return "FRAME_INVALID", None
            if valid_timestamp(fields[122]) > valid_timestamp(fields[52]):
                return "FRAME_INVALID", None
        elif 122 in fields:
            return "FRAME_INVALID", None
        expected_ids = (("TF3C_INITIATOR", "TF3C_ACCEPTOR") if direction == "I_TO_A"
                        else ("TF3C_ACCEPTOR", "TF3C_INITIATOR"))
        if (fields[49], fields[56]) != expected_ids:
            return "COMP_ID_MISMATCH", None
        if extra_headers:
            return "PROFILE_OPTION_UNSUPPORTED", None
        message_type = fields[35]
        if message_type not in dictionary.messages:
            return "MESSAGE_TYPE_UNKNOWN", None
        if message_type not in BODY:
            return {"2": "RESEND_UNSUPPORTED", "3": "SESSION_REJECT_UNSUPPORTED",
                    "4": "RESET_UNSUPPORTED"}.get(message_type, "MESSAGE_UNSUPPORTED"), None
        message = dictionary.messages[message_type]
        allowed, required, groups = dictionary.expand(message)
        group_members = {}
        for group in message.findall("group"):
            count = int(dictionary.by_name[group.attrib["name"]].attrib["number"])
            for member in group:
                if member.tag == "field":
                    tag = int(dictionary.by_name[member.attrib["name"]].attrib["number"])
                    group_members[tag] = count
        if not required.issubset(fields):
            return "MESSAGE_SCHEMA", None
        for tag in body_tags:
            if tag not in allowed and tag not in group_members:
                return "MESSAGE_SCHEMA", None
            if tag in group_members and group_members[tag] not in fields:
                return "MESSAGE_SCHEMA", None
            if not primitive(dictionary.by_tag[tag], fields[tag]):
                return "MESSAGE_SCHEMA", None
        if 112 in fields and not request_id(fields[112]):
            return "MESSAGE_SCHEMA", None
        if 58 in fields and re.fullmatch(r"SYNTHETIC_[A-Z0-9_]{1,48}", fields[58]) is None:
            return "MESSAGE_SCHEMA", None
        if message_type == "A" and fields.get(141) == "Y":
            return "RESET_UNSUPPORTED", None
        if (set(body_tags) - BODY[message_type][1]) or set(body_tags).intersection(groups):
            return "PROFILE_OPTION_UNSUPPORTED", None
        if message_type == "A" and (fields[98] != "0" or fields[108] != "30"):
            return "PROFILE_OPTION_UNSUPPORTED", None
        if fields.get(43) == "Y":
            return "REPLAY_UNSUPPORTED", None
        return None, fields
    except (ProtocolError, KeyError, ValueError):
        return "FRAME_INVALID", None


def evaluate_case(case, frames_by_name):
    """Evaluate admitted immutable byte inputs; never uses expected to choose a result."""
    validate_case(case)
    require(type(frames_by_name) is dict)
    dictionary = schema()
    for event in case["events"]:
        if event["kind"] == "FRAME":
            raw = frames_by_name.get(event["file"])
            require(type(raw) is bytes and len(raw) <= 8192)
            require(hashlib.sha256(raw).hexdigest() == event["sha256"])
    state = "NEW"
    counters = {"I_TO_A": 1, "A_TO_I": 1}
    pending = {"I_TO_A": None, "A_TO_I": None}
    used_requests = set()

    def report(code, index):
        return dict(classification=CODE_CLASS[code], code=code, event_index=index,
                    state=state, next_i_to_a=counters["I_TO_A"],
                    next_a_to_i=counters["A_TO_I"], pending_i=pending["I_TO_A"],
                    pending_a=pending["A_TO_I"], **CLAIMS)

    for index, event in enumerate(case["events"]):
        kind = event["kind"]
        if kind == "RECONNECT_ATTEMPT":
            return report("RECONNECT_UNSUPPORTED", index)
        if kind == "CONNECTION_LOST":
            return report("AFTER_CLOSED" if state == "CLOSED" else "CONNECTION_LOST", index)
        if kind == "END":
            if state == "CLOSED":
                return report("COMPLETE", index)
            code = {"NEW": "EMPTY_SESSION", "LOGON_PENDING": "LOGON_REPLY_MISSING",
                    "LOGOUT_PENDING_I": "LOGOUT_REPLY_MISSING",
                    "LOGOUT_PENDING_A": "LOGOUT_REPLY_MISSING"}.get(state)
            return report(code or ("TEST_RESPONSE_MISSING" if any(pending.values())
                                   else "LOGOUT_MISSING"), index)
        direction = event["direction"]
        opposite = "A_TO_I" if direction == "I_TO_A" else "I_TO_A"
        code, fields = inspect_frame(frames_by_name[event["file"]], direction, dictionary)
        if code:
            return report(code, index)
        message_type = fields[35]
        if state == "CLOSED":
            return report("RECONNECT_UNSUPPORTED" if message_type == "A"
                          else "AFTER_CLOSED", index)
        sequence = int(fields[34])
        if sequence < counters[direction]:
            return report("SEQUENCE_TOO_LOW", index)
        if sequence > counters[direction]:
            return report("RECOVERY_REQUIRED", index)
        if state == "NEW":
            if (direction, message_type) != ("I_TO_A", "A"):
                return report("STATE_TRANSITION", index)
            state = "LOGON_PENDING"
        elif state == "LOGON_PENDING":
            if (direction, message_type) != ("A_TO_I", "A"):
                return report("STATE_TRANSITION", index)
            state = "ESTABLISHED"
        elif state.startswith("LOGOUT_PENDING_"):
            expected_direction = "A_TO_I" if state.endswith("_I") else "I_TO_A"
            if (direction, message_type) != (expected_direction, "5"):
                return report("STATE_TRANSITION", index)
            state = "CLOSED"
        elif message_type == "A":
            return report("STATE_TRANSITION", index)
        elif message_type == "0":
            if 112 in fields:
                if pending[opposite] != fields[112]:
                    return report("TEST_REQ_ID_MISMATCH", index)
                pending[opposite] = None
        elif message_type == "1":
            if pending[direction] is not None:
                return report("TEST_REQUEST_ALREADY_PENDING", index)
            if fields[112] in used_requests:
                return report("TEST_REQ_ID_REUSED", index)
            pending[direction] = fields[112]
            used_requests.add(fields[112])
        elif message_type == "5":
            if any(pending.values()):
                return report("ERROR_LOGOUT_UNSUPPORTED", index)
            state = "LOGOUT_PENDING_I" if direction == "I_TO_A" else "LOGOUT_PENDING_A"
        counters[direction] += 1
    raise CorpusError("CORPUS_INVALID")


def verify_corpus(manifest_path=DEFAULT_MANIFEST):
    """Admit the whole corpus before classifying any prefix; compare literal reports."""
    path = Path(manifest_path)
    manifest = load_manifest(path)
    references = {}
    for case in manifest["cases"]:
        for event in case["events"]:
            if event["kind"] == "FRAME":
                name, digest = event["file"], event["sha256"]
                require(name not in references or references[name] == digest)
                references[name] = digest
    try:
        discovered = set()
        with os.scandir(path.parent) as entries:
            for item in entries:
                if item.name.lower().endswith(".fix"):
                    # Reject before retaining any name outside the finite manifest.
                    require(item.name in references)
                    discovered.add(item.name)
        require(discovered == set(references))
        frames = {}
        total = 0
        for name, digest in references.items():
            raw = read_bounded(path.parent / name, 8192)
            total += len(raw)
            require(total <= 262144)
            require(hashlib.sha256(raw).hexdigest() == digest)
            frames[name] = raw
    except OSError:
        raise CorpusError("CORPUS_INVALID") from None
    # The immutable reference is checked even for an END-only corpus.
    schema()
    reports = []
    for case in manifest["cases"]:
        actual = evaluate_case(case, frames)
        if actual != case["expected"] | CLAIMS:
            raise ExpectationMismatch("EXPECTED_RESULT_MISMATCH")
        reports.append(actual)
    return reports


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if len(args) > 1:
        print("Session corpus invalid.", file=sys.stderr)
        return 2
    try:
        reports = verify_corpus(Path(args[0]) if args else DEFAULT_MANIFEST)
    except ExpectationMismatch:
        print("Session expected result mismatch.", file=sys.stderr)
        return 1
    except Exception:
        print("Session corpus invalid.", file=sys.stderr)
        return 2
    print("Offline session conformance: " + str(len(reports)) +
          " reviewed cases matched; no peer, delivery or financial-application claim.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
