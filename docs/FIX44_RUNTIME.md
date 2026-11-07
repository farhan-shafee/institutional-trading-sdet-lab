# Selected local FIX session runtime

Phase 3C1 implementation candidate, November 7, 2026. Human acceptance, merge
and deployment are separate. This implements synthetic session transport;
financial handoff in 3C2 and Phase 4 remain unfinished.

## Runtime and response policy

QuickFIX/J 3.0.2 is the TRADEFLOW initiator; QuickFIX/Go v0.9.12 is the ATLAS
acceptor. Engine sources remain unmodified. The locked build uses Go 1.27.3,
Java 21 and digest-pinned images. Runtime VERSION events identify the actual
engine/toolchain and the separate `matching-testreq-v1` TradeFlow policy.

Both wrappers require `TradeFlowResponseGuard=matching-testreq-v1`. One pending
TestRequest anchors a monotonic 36-second deadline. Ordinary traffic or wrong
112 cannot answer it or extend it. A validated matching heartbeat must arrive
strictly before the deadline with SendingTime strictly within 120 seconds.
The wrapper control loop stops its own engine on expiry, outside callbacks.
It neither changes wire bytes nor performs engine sequence validation itself.

The [design revision](superpowers/specs/2026-11-07-fix-response-guard-design.md)
explains the composite: both pinned engines clear native TestRequest bookkeeping
on ordinary traffic. Acceptance belongs to the named engine-plus-guard profile;
it is not upstream or full FIX certification.

## Mandatory gate

With Node 24, Python 3.12+, Docker and `npm ci`, run from the repository root:

```sh
npm run test:fix-session
```

`PYTHON` can select an interpreter. The same command is a dedicated CI job and
part of `validate:all`. The gate has a 900-second total bound. Ordinary controls
have 60 seconds; real timer controls have 150 seconds. Original assertions,
project test deadlines and retries are unchanged.

All 43 declared cases bind to executed tests or host inspections. Zero discovery,
missing cases/expectations, skips, wrong pins/hashes, child failures, output
limits, deadlines or changed build inputs fail the gate. Current D/8/F/9 wire
is sent directly to the unchanged TypeScript decoder. Daemon disk logging is disabled; output is attached before startup and streamed\ninto a bounded host file. Configs, stderr and every owned state file are counted.\nEvidence, including first\nfailures, is retained under `artifacts/fix-session-*/`. Summaries identify the
image, build-input hash, original source preservation, real test count and
original codec outcomes.

Review the [manifest](../test-data/fix44/runtime/manifest.json),
[bindings](../test-data/fix44/runtime/bindings.json) and
[JSON profile](../contracts/fix-session-runtime-v1.json). JSON keeps the Python
runner independent of an additional YAML dependency. All values were compared
with the earlier YAML profile before renaming it.

## Observed qualification

The November 7 pre-metadata checkpoint passed **43/43 cases and 78/78 controls**
in 387.354 seconds; the host command exited 0 in 391.28 seconds. Coverage includes
both directions' live timeout and cancellation, reconnect, physical duplicates,
application resend, admin gap fill, actual persisted-send/receive process kills
and restart, corrupt-store denial, calendar, exact limits and failure cleanup.

The integrated Go package passed nine checks under `-race`. Java's eight literal
guard checks and both deterministic engine calendar checks run during build.
Later license-retention and build-input mutation controls are additional checks;
use the current run summary for its exact final count. Complete regression and
CI results belong to the exact candidate in [PR #34 checks](https://github.com/farhan-shafee/institutional-trading-sdet-lab/pull/34/checks).
An earlier successful run does not qualify subsequent changes.

## Ownership and limits

One runtime container has network disabled, no host ports or mounts, read-only
root, no capabilities, 1 CPU, 1 GiB memory, 128 PIDs, 64 MiB shm and 64 MiB writable
tmpfs. Private loopback ports are 19875/19876. Build dependency access is separate.
Runtime has no application SDK, database configuration or Docker socket.

One UUID-owned root and lock guard separate engine stores. A named kill barrier
observes counters, pauses the owned child, inventories/checkpoints every expected
store file and sends actual SIGKILL. Restart verifies unchanged bytes before
spawn. New process/connection identities remain distinct from the original run.
Expected historical kills remain visible. Continuity is claimed separately after
new Logon and retained-counter checks. Missing, changed, unowned or uncertain
stores never become fresh empty stores.

Limits: 8192 bytes/frame, 16384 bytes/buffer, 64 fields, 256 bytes/value, 16 frames
per dispatch, 512 wire observations, 1024 child events, 4 MiB child stdout, 16 fault
rules/held frames and eight process lifetimes. Budget exhaustion denies SEND and
retains failure evidence. Cleanup targets only owned tracked processes; forced
cleanup is a failed receipt. Scenario exceptions now carry a fixed reason and
all fault rules share the cap, resolving the prior review's two deferred minors.

Evidence completeness, session continuity and financial application are separate.
Financial-application, external-delivery and external-completeness claims remain
false. Store continuity covers process restart within one container. Container
loss, power-loss durability and high availability remain unresolved.

## Integration boundary

Actual D/8/F/9 bytes still produce `FIELD_ORDER` in the unchanged strict TradeFlow
decoder. Original bytes and hashes remain retained; no replacement wire is
produced. Old financial app/SQL, migrations001-008, dictionary and goldens remain
preserved. A versioned 3C2 ingress/authority contract is required before financial
SDK handoff. A callback is not an execution, ledger mutation or external receipt.

## Historical failure and references

At `59eddb41fb0ecdc64e36e3315176006d425c1b22`, an ordinary heartbeat cleared Go's
native pending-timeout state. The first TestRequest occurred near 36 seconds and
another followed 36.004035 seconds later instead of disconnecting. The isolated
failing command exited 1 after 77.942 seconds; its no-heartbeat paired control
passed after 74.079 seconds. The old full collection was 49/50 and correctly
remained blocked. First failures remain evidence; the required test is unchanged.

The exact November 2020 standard and June 2020 test cases were admitted before
matrix authoring. The gate verifies frozen edition identities and admission
controls; it does not re-download or re-certify standards on every execution.
Optional `TRADEFLOW_FIX_REFERENCE_DIR` supplies `<sha256>.pdf` files for bounded
byte/hash revalidation. Challenge pages never satisfy admission. See
[provenance](../verification/vendor/fix-session/REFERENCES.md) and
[runtime attribution](../verification/vendor/fix-session/THIRD_PARTY.md).
