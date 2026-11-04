# Offline FIX session contract and conformance pack — Phase 3C0

The owner approved the bounded 3C0 contract in sections 10 and 17 of
[the phase plan](plans/PHASE3C.md). This is an offline classifier and reviewed
transcript pack. It does not open a connection, schedule a heartbeat, persist a
session, run a peer engine or call the financial SDK.

A successful corpus command means each supplied positive, invalid, incomplete
and out-of-scope case produced its separately authored literal result. It does
not mean every transcript is conformant. Every report explicitly keeps peer
interoperability, delivery, financial application and external completeness
verification false.

## Run and inspect

From the repository root, using Python 3.12+ and the locked Node 24 setup:

    python3 -m unittest verification/python/test_fix_session_reference.py -v
    python3 verification/python/fix_session_reference.py
    npm run test:fix44
    node --import tsx --test tests/unit/fix44/session-contract.test.ts

The existing FIX command still executes its original seven Python tests and 14
TypeScript-encoded application goldens first. It then targets the mandatory
session test file explicitly and verifies the session corpus. Missing new tests,
unexpected cases, changed hashes and child failures propagate nonzero. The
existing 60-second child-process deadline is unchanged.

The initial inventory contains 59 reviewed cases and 57 immutable raw files,
listed in test-data/fix44/session/manifest.json. Expected reports were authored
before the checker and independently reviewed. Raw fixtures use actual SOH and
are never repaired or normalized by the evaluator. Deliberately invalid raw
fixtures retain their defect.

CLI exit 0 means all reviewed expected reports match. Exit 1 means an expected
result mismatch. Exit 2 means invalid corpus/reference input or unexpected
checker failure. Diagnostics omit raw payloads, untrusted exception text and
input paths. The checker emits no evidence file or runtime identity material.

## Supported subset

I is the fictional initiator TF3C_INITIATOR; A is the fictional acceptor
TF3C_ACCEPTOR. CompIDs establish synthetic correlation only.

| Message       | Selected body              | Meaning in this pack                                           |
| ------------- | -------------------------- | -------------------------------------------------------------- |
| Logon A       | 98=0, 108=30; 141 absent/N | Fresh I Logon followed by A Logon                              |
| Heartbeat 0   | Optional 112               | Ordinary heartbeat or exact outstanding-request response       |
| TestRequest 1 | Required 112               | One outstanding request per requester; case-wide unique ID     |
| Logout 5      | Optional synthetic 58      | Orderly request/response after outstanding probes are answered |

The selected header is 8,9,35,49,56,34,[43],52,[122], with tag 10 last.
Framing, canonical bounded sequence syntax, timestamps, replay header structure,
known optional headers, required body membership and dictionary primitives are
checked before state transitions. The existing four-message application decoder
continues rejecting these administrative messages.

A valid in-sequence frame advances only its direction's counter. Each independent
case begins at 1/1. The evaluator retains the last accepted prefix on any terminal
diagnostic. Crossed TestRequests are tracked separately; an ordinary heartbeat
does not clear a request, and a wrong echo cannot consume a sequence number.
Closed-state and request-ID precedence follow the exact phase-plan matrix.

The outcomes are:

| Classification      | What it establishes                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------- |
| IN_SCOPE_CONFORMANT | Selected orderly transcript reached CLOSED then END                                         |
| INVALID             | Observed input violates this selected contract, not necessarily every FIX profile           |
| OUT_OF_SCOPE        | A known excluded option, replay, recovery, reset, reconnect or message path was encountered |
| INCOMPLETE          | Supplied valid prefix lacks required completion or declares connection loss                 |

No sequence gap is skipped, buffered or repaired. ResendRequest, SequenceReset,
Reject, replay and application messages receive explicit classifications rather
than being silently treated as successful session behavior. A new offline case
is a different declared synthetic session, not permission to reset a real one.

Heartbeat scheduling, elapsed thresholds, current-clock freshness, real recovery,
and independent send/arrival concurrency are NOT_EVALUATED. This pack is not
a complete FIX session conformance suite.

## Finite input and filesystem ownership

Manifest admission is strict: duplicate/unknown JSON keys, bad classifications,
code pairings, IDs, event shapes, missing END, hash conflicts and missing/orphaned
files fail. Every referenced file is admitted and hashed before any transcript
prefix is evaluated. A terminal early classification cannot hide a later missing
or changed file.

| Bound                                       |       Maximum |
| ------------------------------------------- | ------------: |
| Manifest bytes                              |       128 KiB |
| Cases                                       |            64 |
| Events before final END per case            |            32 |
| Unique raw files, counted once per filename | 256 KiB total |
| Raw frame file                              |         8 KiB |
| Fields / bytes per value                    |      64 / 256 |

Oversized manifest/raw files and corpus bounds fail before unbounded allocation.
Field/value bounds are frame-classification failures. File names are flat relative
names inside the manifest directory. Symlink/reparse path components and
nonregular files are rejected. Opened-file identity and size are checked around
the bounded read. This is a local read-only tool; it does not grant filesystem
permissions or claim a cross-platform filesystem race-proof sandbox.

## Independent evidence and preservation

The base QuickFIX dictionary and license remain pinned and unchanged. The Python
checker uses the existing independent framing/dictionary metadata, never the
production TypeScript codec or financial implementation. Its selected state
rules are independently coded rather than executed from the YAML contract.
Reference hashes are checked even after the XML object has been cached.

TypeScript checks the reviewed corpus inventory, actual byte counts/checksums,
unchanged application-decoder exclusions and real FIX-command failure
propagation. It does not implement a second session state machine. Deliberate
negative controls run separately from normal accepted corpus reports.

The [June 2020 FIX session standard](https://www.fixtrading.org/wp-content/uploads/download-manager-files/FIX_Session_Layer_June_2020.pdf)
was consulted for the limited session concepts. The current official catalog
lists later errata; this pack does not claim its full compliance. The phase plan
distinguishes base facts from every proposed bilateral choice and records the
later standard/peer review needed for the engine milestone.

All existing application source, economic contracts, migrations 001–008, SQL
verifiers, base dictionary/license, original 14 goldens, dependency locks,
workflows, capacity policies, deadlines and retries remain unchanged. No schema
or production deployment is needed. The later local session engine and genuine
independent-peer interoperability remain separate work.
