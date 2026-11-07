# Owner approval

The owner approved this recommended design and implementation on November 7, 2026. Draft-status and approval-request wording below is retained as the reviewed proposal history. Implementation/acceptance status is recorded separately in the plan and evidence.

# TradeFlow Phase 3C1: local FIX sessions and peer testing

Status: **Proposed design for owner review. Implementation has not started.** The recommendations below are the assistant's engineering choices, not decisions previously approved by the owner.

Source inspected: protected main `c9cf9b76b760645acc884b12ae3ee42982ca9727`. The live application remains pinned to `b0216022cb8ff18de904efea9279c91b3977d55f`. Existing worktrees are clean and preserved. This document does not change that application.

## Outcome and scope

Build a reproducible synthetic local session demonstration using an established engine and a separately implemented peer. A reviewer should observe Logon, heartbeats/TestRequest, orderly Logout, reconnect with retained sequences, resend/gap-fill behavior and bounded failure handling over real sockets.

This is the next implementation milestone, provisionally called **3C1**. The label is new. Completing it will not finish all of Phase 3C or Phase 4.

| Milestone                 | Deliverable                                                                                                                                      | Closure condition                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Existing 3C0              | Offline contract/transcript classifier                                                                                                           | Already accepted; preserve unchanged                               |
| Proposed 3C1, this design | Running local sessions, retained engine stores, independent engine peer, transport-only application probes                                       | Exact case matrix below passes; review and human acceptance        |
| Following 3C2             | Trusted session-to-TradeFlow financial SDK handoff, immutable wire/application mapping, original-key recovery across transport/database failures | Separate concrete adapter/schema contract and financial acceptance |
| Remaining Phase 4A-4F     | Instruments, curves, portfolio risk, corrections, settlement and P&L                                                                             | Separate finite economic contracts and tests                       |

The owner asked to proceed with unfinished FIX work. The inherited roadmap leaves runtime roles, store, reset/resend policy and peer selection open. This document makes the proposed first runtime slice reviewable before dependencies or a listener are introduced.

## Approaches

| Approach                                                 | Benefit                                                                                                                     | Cost / limitation                                                                                         |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Recommended: QuickFIX/J runtime and QuickFIX/Go peer** | Two separately implemented engines; concentrate project work on adapters, persistence evidence, fault cases and integration | Java and Go build tooling; engine behavior must be measured and pinned                                    |
| Custom TypeScript session engine with QuickFIX/J peer    | Most code stays in the existing language; exposes state-machine implementation                                              | New sequencing, timer, persistence and recovery implementation creates substantial extra correctness work |
| One engine on both sides                                 | Smallest toolchain                                                                                                          | Useful smoke only; insufficient evidence of independent implementation interoperability                   |

Recommendation: first option. Keep the current Node/TypeScript financial application; Java and Go belong to a separate opt-in local verification tool. Both engines have common FIX/QuickFIX lineage, so their agreement is supporting evidence, not an independent financial oracle or proof of full FIX compliance.

Candidate engine pins are QuickFIX/J 3.0.2 and QuickFIX/Go v0.9.12, based on the official documentation/release pages inspected for this design. Before execution, resolve exact source revisions, artifact SHA-256 values, licenses, complete transitive dependencies, compatible toolchain versions and container digests into a checked-in lock/manifest. Any unavailable or incompatible pin is a reported preflight blocker; do not silently substitute another version. A current advisory scan is required. No engine package or compiler has been installed for this design.

## Local architecture and ownership

The runtime is a small QuickFIX/J initiator, with QuickFIX/Go acting as the fictional ATLAS acceptor. The existing app is not imported or started by this milestone.

Use one owned Linux container with a private network namespace and **no external network** at runtime. Both processes use 127.0.0.1 inside that namespace; publish no host ports and use no host networking. Dependency acquisition/build is a distinct preparatory step; the acceptance runtime works without network access. This avoids treating separate containers' loopback addresses as the same machine.

The driver owns one synthetic session and one peer connection per run. Acceptor binds loopback port 19876 inside the isolated namespace; a port collision fails without killing another process or changing its listener. CompIDs are TRADEFLOW and ATLAS. Identity is FIX.4.4 plus both CompIDs and a local run/session UUID that is recorded in private ownership metadata, not invented as a new FIX header.

Separate initiator and acceptor stores reside beneath one descriptor-owned run directory. A process lock prevents a second writer. Restart reuses that directory and identity; a fresh directory is a distinct explicit session. Store corruption, missing files or identity mismatch must not cause an automatic reset to 1.

Run limits: 1 CPU, 1 GiB memory, 128 PIDs, 64 MiB shared memory, one connection per side, 8 KiB frame limit, 16 KiB buffered frame input, 64 fields and 256 bytes per value for admitted fixtures. Store/log/input-output evidence is capped at 64 MiB total per owned run. New outbound work stops at the cap; exhaustion is a failure result, not permission to delete unacknowledged evidence. No existing financial/SQL timeout, quota, retry or admission rule changes.

Runtime image root is read-only. Writable state is limited to the owned store and bounded temporary directory. No Docker socket, host home directory, production environment file or database credential enters the container. Verify resource availability before starting; do not restart WSL/Docker or stop unrelated workloads to make the gate fit.

## Session contract

Profile: FIX.4.4, one continuous synthetic session. Start both counters at 1 only for a newly created session. Disable automatic sequence reset on Logon, Logout, disconnect and calendar boundary. Use the documented continuous-session setting for each pinned engine and verify its effective behavior. Settings parity is a test requirement; a config key ignored by an engine is a failure.

- Required administrative paths: A Logon, 0 Heartbeat, 1 TestRequest, 2 ResendRequest, 3 SessionReject, 4 SequenceReset **gap fill only**, and 5 Logout.
- Logon uses 98=0 and 108=30, no credentials, no encryption or authentication claim. ResetSeqNumFlag 141=Y is rejected for this profile.
- Heartbeat interval is 30 seconds. Each engine's timer behavior is recorded against the pinned implementation. Deterministic clock/barrier controls cover boundary conditions; at least one actual elapsed-time heartbeat/TestRequest/disconnect case verifies live timers.
- Ordinary Heartbeat cannot answer an outstanding TestRequest. Response 112 must match the request. Invalid or missing response results in the observed reject/logout/disconnect outcome specified by the independent case fixture.
- New in-sequence traffic advances the appropriate directional session sequence. Reconnect preserves both counters and retained message bytes. CompIDs correlate fictional parties; they never grant a financial capability.
- High sequence triggers bounded recovery. Low sequence without valid duplicate treatment is rejected/disconnected, with no application callback admitted as new work.
- Retransmitted application probes retain their original business identity and body. Header changes for 43=Y, 122 and SendingTime are separately recorded. Do not relabel replay as a fresh economic operation.
- Gap-fill mode may cover only skipped administrative sequence positions. It may not conceal a retained application probe or stand in for an unavailable application body. Sequence-reset mode 123=N, manual store clearing and counter rewrites are unsupported.
- The case matrix distinguishes reconnect, replay, physical duplicate observation and a new logical application probe. Each has separate transport observations; none authorizes an execution.
- Unexpected message types, malformed frames, checksum errors, size violations and conflicting duplicate payloads fail closed. Engine-specific negative responses are literal, version-bound expectations in the reviewed case manifest; two engines need not emit identical diagnostic text.

This is a selected bilateral profile. Retrieve and hash the FIX Session Layer Technical Standard with November 2020 errata and its published test cases before implementing the test manifest. Map each selected rule to its section/test and list excluded tests explicitly. Preserve the existing base FIX44 dictionary and 3C0 hashes; do not overwrite them with a peer engine's dictionary. Full standard certification remains unclaimed.

## Transport-only application probes and compatibility preflight

Use finite synthetic D/8/F/9 examples to test message exchange, resend and decimal preservation. The peer may acknowledge receipt at its callback, but it does not call OrderService, FixFoundationService or FixApplicationService. Received probes are named TRANSPORT_ONLY; financial_application_verified remains false.

Carry prices, quantities and identifiers as exact strings. Never round-trip 100.050000000123 through Java double, Go float64 or JavaScript Number. Compare original bytes, decoded field values, message identities and independently authored expectations.

A concrete compatibility issue must be checked early: the existing TradeFlow codec requires a fixed header order and a deliberately restricted field set. Mature engines assign session headers and may serialize them differently. Both engines' actual emitted bytes must be tested against that profile. Preserve actual wire bytes and their hash. Do not normalize bytes and then describe the normalized form as received wire evidence, weaken the current decoder, or overwrite old goldens to pass.

If header/order/options are incompatible, 3C1 may still establish its declared session/transport-only cases, with the mismatch recorded. The following financial adapter design must define a versioned wire-to-application mapping or additive profile/schema/verifier extension before any wire message can reach the SDK. Such a mismatch blocks claiming full Phase 3C integration.

## Evidence and restart semantics

Capture exact synthetic wire frames from the owned test transport, directional sequences, monotonic event observations, process identities, engine versions/hashes, config/store hashes and run ownership. Do not put bearer proofs, raw host environment or engine stack traces with secrets into published evidence.

The engines own their session stores. The harness may inspect store bytes but cannot edit sequence files to manufacture a recovery scenario. Induce gaps through an owned fault proxy in the same isolated namespace; it may drop/duplicate/disconnect selected frames using a declared deterministic case script. It must retain both sender and receiver observations. A drop after send is not proof the receiver saw a message.

Process-kill tests are actual process termination at named barriers, followed by restart from retained stores. Report which crash points are supported by the pinned store. A torn/corrupted store must fail safely and cannot be replaced with an empty store under the same identity. Filesystem/process restart evidence does not prove power-loss durability.

Every result keeps separate fields for peer callback receipt, recovered session continuity, transport evidence completeness and financial application. No boolean called delivery_verified may imply external delivery, external completeness or ledger commitment. A peer callback proves only the observed synthetic local receipt for that frame.

## Required acceptance matrix

Each family has at least one named positive case and the specified negative/boundary cases. Literal expectations, source rules, inputs and observed event/state outcomes are frozen before implementation; counts come from actual discovery.

| ID  | Family                   | Required observation                                                                                                                     |
| --- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| S01 | Fresh Logon / Logout     | Correct CompIDs, counters and orderly closure; either party can initiate Logout                                                          |
| S02 | Live timer behavior      | Ordinary heartbeat, each TestRequest direction, matching response and missing response; no arbitrary sleep-based readiness               |
| S03 | Reconnect                | Disconnect/reconnect and each process restart preserve original session/counters                                                         |
| S04 | Receiver gap             | Declared dropped frame triggers recovery; later business probe cannot leap over the gap                                                  |
| S05 | Sender resend            | Application probe reappears with correct original identity, body and replay headers                                                      |
| S06 | Administrative gap fill  | Skip administrative positions only; never skip a retained application probe                                                              |
| S07 | Duplicates               | Identical physical duplicate versus conflicting identity/body are distinguishable; no new logical work inferred                          |
| S08 | Invalid sequence/reset   | Low non-duplicate sequence, invalid gap fill, 141=Y, 123=N and corrupt store are rejected without resets                                 |
| S09 | Byte/profile boundary    | Actual SOH, checksum/body length, fragmentation/coalescing, exact decimals, unknown fields/types and existing-codec compatibility result |
| S10 | Ownership/security       | Second writer denied; non-loopback configuration denied; no host ports/external runtime network; owned cleanup only                      |
| S11 | Resource limits          | Exact/one-over frame, input, queue and store budgets; bounded shutdown on failed peer or writer                                          |
| S12 | Crash/uncertainty        | Actual process kills around persisted-send/receive barriers; no silent loss or manufactured receipt                                      |
| S13 | Discovery and failures   | Missing case/tool/pin/hash/expected result and child nonzero/deadline propagate failure; zero-case success impossible                    |
| S14 | Isolation from economics | No database client/SDK import or credentials; transport callback leaves all financial-application claim fields false                     |
| S15 | Historical preservation  | Existing 3C0 rules, application goldens, migrations001-008, financial kernel and current release settings remain unchanged               |

The pinned engines are not independent oracles for financial correctness. Keep the existing Python dictionary/byte oracle. Later 3C2 adds authoritative PostgreSQL receipts, original financial key mapping and the independent SQL/Python financial oracles.

## Proposed file ownership and delivery

New isolated checkout from verified current main; preserve all existing branches/worktrees. Candidate paths:

- `tools/fix-session/java/`: QuickFIX/J runtime, restricted configuration and runtime entry point.
- `verification/fix-peer/go/`: independent QuickFIX/Go peer and literal scenario driver.
- `contracts/fix-session-runtime-v1.yaml`: selected runtime profile and budgets, separate from offline v1.
- `test-data/fix44/runtime/`: reviewed raw cases, literal expected outcomes and case discovery.
- `scripts/test-fix-session.ts`: owned build/runtime orchestration, bounded process execution and safe cleanup.
- `tests/fix-session/`: protocol, store, fault, ownership and negative controls.
- `docs/FIX44_RUNTIME.md`: reproducible setup, effective configs, interruption/recovery and actual limits.
- `verification/vendor/fix-session/`: exact standard/test references, licenses and hashes.
- A dedicated build manifest and mandatory CI session job; no dependency added to the public app runtime.

The builder may choose small internal file splits, build cache layout and compatible compiler/container patch versions, but must pin and disclose them. If a safe owned store, network or byte-evidence hook cannot be achieved without an engine patch, stop for a specific design revision; do not quietly patch upstream engines.

Delivery gates: (1) lock/reference and compatibility preflight, (2) case manifest plus failing controls, (3) real session/peer implementation, (4) restart/replay/resource cases, (5) complete existing regression gates plus the new session gate and independent review. Existing gate commands, assertions and policy limits remain. New build/acceptance deadlines must be finite and recorded before executing; they do not expand any existing suite deadline.

No source merge, production migration, public FIX listener, hosting change or Phase 4 implementation is included in approval of this first runtime design. A reviewable feature PR and actual evidence are the output of implementation; human acceptance precedes integration. The public website remains on its accepted release.

## Readiness observations and approval requested

Read-only inspection found Windows Java 17 JRE, a Java 17 JDK compiler and Maven, no Go compiler in the inspected command paths, and WSL Docker server 29.9.2. These are inventory observations, not a compiled-toolchain acceptance result. A locked owned build image is proposed to avoid global toolchain installation. Runtime/build readiness and exact artifact availability have not yet been qualified.

**Decision requested:** approve the recommended two-engine, local-only 3C1 design and its transport-only boundary. This permits preparing the locked toolchain, implementing the isolated runtime/peer and tests, and returning a feature PR with complete evidence. It does not mark 3C1 done, authorize financial session handoff before its design, complete Phase 3C/4, or deploy anything publicly.

## Design review

A fresh read-only reviewer checked whether the design leaves important questions before implementation planning. Result: no important owner questions remain. Dependency pins, literal fixtures, supported crash barriers, queue budgets and new gate deadlines remain explicit preflight/case-manifest deliverables, not completed tests. This is an AI design review, not human approval or source/runtime acceptance.

## Source references

Repository evidence at `c9cf9b7`: AGENTS.md; docs/CURRENT_STATE.md; docs/plans/PHASE3C.md; docs/IMPLEMENTATION_PLAN.md; docs/TEST_STRATEGY.md; docs/FIX44_APPLICATION.md; docs/FIX44_FOUNDATION.md; app/server/fix/application.ts; app/protocol/fix44/index.ts and profile.ts; contracts/fix-session-v1.yaml; existing PostgreSQL FIX fixtures. The initial lookup of a nonexistent service.ts/framer.ts path was corrected by actual directory/source inspection.

Primary external references, read for this proposal:

- https://quickfixj.org/docs/overview/
- https://quickfixj.org/docs/configuration/
- https://quickfixj.org/docs/installation/
- https://github.com/quickfixgo/quickfix/releases
- https://quickfixengine.org/go/documentation/getting-started/configuration.html
- https://fixtrading.org/standards/fixsession/
- https://fixtrading.org/packages/fix-session-layer-technical-standard/
- https://fixtrading.org/packages/fix-session-layer-test-cases/

No dependency, compatibility, runtime or acceptance test is reported passed by this planning document.
