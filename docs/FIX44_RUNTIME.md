# FIX session runtime: blocked prototype

Status on November 7, 2026: **not accepted, not complete, not ready to merge**.
The approved QuickFIX/Go v0.9.12 peer fails a required TestRequest response
control. No engine patch, replacement version, extra session watchdog, financial
SDK integration, main merge, or deployment has been applied.

## Verified scope

The isolated prototype runs QuickFIX/J 3.0.2 as TRADEFLOW initiator and
QuickFIX/Go v0.9.12 as ATLAS acceptor. The actual runtime reports Go 1.27.3
and Temurin JRE 21.0.13+9-LTS. It uses real loopback sockets inside one
network-disabled container. It has no host ports, database credentials or
financial application. All prices and quantities remain strings.

Separate runs passed four runtime smoke tests and five fault tests: Logon,
Logout initiated by either side, D/8/F/9 transport callbacks, exact decimal
preservation, TestRequest echoes in both directions, reconnect sequence
continuity, application resend and administrative gap fill. These results do
not close the declared 43-case matrix or establish financial delivery.

Actual D/8/F/9 bytes all fail the existing strict TradeFlow decoder with
`FIELD_ORDER`. The captured bytes and their hashes are retained in
`test-data/fix44/runtime/captured-compatibility.json`. No existing decoder,
dictionary, golden, migration or financial application file was changed.
A separately reviewed versioned mapping is still required before financial
handoff in 3C2.

## Blocking timer result

Source: the hashed FIX Session Layer Technical Standard, November 2020 errata,
section 4.5.5; published June 2020 test cases, section 4.5.5. The selected
profile requires the outstanding TestRequest to be answered by a heartbeat
carrying its matching TestReqID(112).

The real elapsed-time reproduction keeps HeartBtInt at 30 seconds. The proxy
holds the original Java heartbeat at sequence 2, waits for Go's automatic
TestRequest `112=TEST`, holds Java's matching response at sequence 3, then
releases only the original ordinary heartbeat. All bytes remain unchanged and
in sequence. No application message, store edit or engine clock change is used.

| Observation                      | Released ordinary heartbeat                                        | Nothing released, paired control |
| -------------------------------- | ------------------------------------------------------------------ | -------------------------------- |
| Automatic Go TestRequest         | Observed after about 36 seconds                                    | Observed after about 36 seconds  |
| Matching response forwarded      | No                                                                 | No                               |
| Outcome after another 36 seconds | Another TestRequest; no disconnect by 40-second assertion deadline | Go disconnects as expected       |
| Test result                      | Exit 1; 77.942 seconds                                             | Exit 0; 74.079 seconds           |

In the failing run, the ordinary heartbeat reached Go 0.003867 seconds after
its first TestRequest. Go sent a second TestRequest 36.004035 seconds later.
Logout events in cleanup occur after the failed assertion and are not counted
as a successful timeout. Both owned processes then exited 0. The retained
receipt sets `transport_evidence_complete=false` and every financial or external
delivery claim remains false.

The pinned source explains this result: `pendingTimeout` embeds the previous
session state and inherits its message handler. The ordinary heartbeat passes
that handler, which returns `inSession`; the peer timer is reset on incoming
traffic. No matching-ID check occurs on that path. This is a measured
incompatibility with this selected profile, not a claim that the whole upstream
project or other versions have been certified or comprehensively audited.

The approved plan requires stopping for an incompatible pin or required engine
patch. Implementation therefore stops at this checkpoint. Changing the peer
pin, patching the engine or adding a separate matching-response watchdog needs
a concrete design revision. The failing acceptance test remains a failure.

## Reproduction

Run from the repository root with Docker available. Build downloads are
separate from the network-disabled acceptance runtime. These are limited
prototype commands, not the future complete `test:fix-session` gate.

```sh
timeout --signal=TERM --kill-after=5s 900s docker build --platform=linux/amd64 -f tools/fix-session/Dockerfile -t tradeflow-fix-session:prototype .

timeout --signal=TERM --kill-after=5s 150s docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --cpus 1 --memory 1g --memory-swap 1g \
  --pids-limit 128 --shm-size 64m \
  --tmpfs /state:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000,mode=0700 \
  tradeflow-fix-session:prototype \
  python -m unittest discover -s tests/fix-session -p test_timer_runtime.py -v
```

Expected result for the blocking command: **nonzero**, after about 78 seconds.
Use `test_timer_positive_runtime.py` for the paired timeout control,
`test_runtime.py` for the four smoke tests or `test_fault_runtime.py` for the
five fault tests. Each live timer scenario has the approved 150-second bound.
The raw synthetic `LAB_RECEIPT` output is evidence, not an external receipt.

## Limits and unfinished work

The image root is read-only. All writable engine stores, configs and wire
observations reside in a 64 MiB tmpfs. Process restarts within that container
may reuse retained bytes only after admission. Container loss is unresolved;
this prototype makes no container-restart, power-loss or high-availability
durability claim. It publishes no FIX listener on the host or public website.

Ownership and framing controls passed separately: second writer/wrong identity,
missing or changed checkpoint bytes, unreadable directories, symlink rejection,
bounded framing, malformed input, duplicate conflicts and selected-profile
reset denial. These unit controls do not substitute for the pending actual
process-kill/restart, deterministic timer/calendar, one-over budget and complete
failure-propagation cases.

Independent review confirmed the timer blocker and found four prototype
defects. Reproducing controls were added before fixes: a reopened identity now
requires a checkpoint before any engine start; unstarted/partial runs fail
instead of claiming completeness; wire append/write order is serialized; and
child output is capped at 1,024 events and 4 MiB total. The review did not
accept the unfinished milestone or rerun the complete project gates.

Two review minors remain deferred: a propagated scenario failure can leave the
receipt's fixed `errors` list empty while completeness is correctly false;
`drop_next` does not yet share `hold_next`'s 16-rule cap. The current declared
scripts supply a finite number of drop rules. Neither item is presented as a
completed resource-boundary acceptance case.

The final portable runner, complete case discovery, dependency/source/license
closure, mandatory runtime CI job, full unchanged regression gates and final
human acceptance remain unfinished. Existing CI does not execute this new
runtime matrix. Passing existing jobs cannot close 3C1. All of Phase 3C and
Phase 4 remain unfinished.
