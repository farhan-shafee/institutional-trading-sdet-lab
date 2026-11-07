# Phase 3C2 local synthetic financial adapter design

Base: `eb5d5826fb64711170e02561368a853e85b7e060`, qualified runtime PR34, unmerged.
The owner requested implementation after receiving the proposed contract. This
copies that contract into repository source and records implementation choices.
No main merge, hosted migration, deployment or Phase4 work is authorized.

## Approach

Use the proposed opt-in local Node/controller + private engine-container bridge.
Normalizing wire into the legacy decoder would destroy provenance and is rejected.
Using callbacks as financial receipts would bypass authority and is rejected.
The selected adapter preserves exact raw evidence, independent SQL validation,
original-key recovery and the existing atomic kernel boundary.

## Proposed Phase 3C2 adapter contract — not implemented

### Purpose and authority

A selected local session may supply immutable evidence to the existing controlled financial workflow. Socket receipt or an engine callback alone must never create an order, execution, position or cash movement. Current engine-generated D/8/F/9 bytes all return `FIELD_ORDER` in the unchanged legacy decoder. Calling `FixApplicationService.ingest` with those bytes, or bypassing its validity result, does not implement integration. `FIELD_ORDER` is the first failure, not proof that header ordering is the only incompatibility; synthetic transport probe IDs and required business fields must also be replaced with genuinely owned, financially valid fixtures.

The existing SDK calls `fi_control.fix_command`, `fi_control.ingest_fix` and `fi_control.apply_fix`. SQL owns proof/generation checks, lane fences, original prepared identity, capacity and atomic financial effects. `apply_fix` invokes the existing private `fi_control.order_command_kernel` within the same transaction as effect-backed consumption, application receipt and protocol audit. The adapter must retain that transaction boundary. SQL cannot cryptographically prove an engine callback; the trusted local controller owns callback provenance, while SQL independently validates bytes, references, authorization and eligibility. No browser-supplied acceptance boolean may establish a callback witness. It must not call a financial command and persist the protocol outcome in a second transaction.

### Selected structure

Use an opt-in server-side Node controller outside the private FIX container. It uses the existing owned local PostgreSQL descriptor and bounded database client. No database credential, browser route, public listener or real venue is added to the engine container. An owned stdio bridge carries versioned JSON-line messages through the controller's attached container process. Existing standalone 3C1 execution remains a distinct mode.

Proposed bridge bounds: 24 KiB per envelope, 16 queued envelopes, one in-flight application frame per direction, five seconds per bridge acknowledgment, and the existing 64 MiB aggregate run evidence/state limit. Raw-observation and callback-acceptance acknowledgments are separate messages referencing the same immutable attempt; a callback envelope need not duplicate the raw hex. An acknowledgment timeout, full queue or unavailable authority stops forward progress and records uncertainty. It does not widen existing transaction, lease, scenario or gate deadlines. These are proposed contract values, not implemented or measured capacities.

### Immutable envelope and distinct identities

| Field group      | Contract                                                                                                                                                                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version/profile  | Explicit `live-fix-ingress-v1`, chosen at binding creation; immutable thereafter. Legacy bindings retain their existing profile.                                                                                                                                                                                |
| Ownership        | Sandbox, binding, order, actor, capability generation and current authorized lane owner/fence; server proof stays outside transport logs.                                                                                                                                                                       |
| Runtime          | Run UUID, engine role/version, wrapper profile, verified store incarnation, connection UUID and direction. A process restart with verified stores does not invent a new sequence epoch.                                                                                                                         |
| Observation      | Physical attempt UUID, exact lower-case raw hex (1–8192 bytes), independently recomputed SHA-256, observed timestamp and capture stage.                                                                                                                                                                         |
| Acceptance       | Exact connection/MsgSeqNum/type correlation to a real validated application callback, or a distinct rejected/unresolved disposition. Caller-supplied decoded fields are never trusted as wire validation.                                                                                                       |
| Logical/economic | Original order/ClOrdID, actual cancellation references, dealer OrderID/ExecID, existing logical message/work UUID and original prepared financial key/payload/hash. These are not transport sequence numbers.                                                                                                   |
| Requests         | Each durable operation retains its original metadata idempotency key. Its SQL-canonical request fingerprint includes the explicit live profile/domain, sandbox/binding, operation, original observation/callback identity and full immutable payload; the financial key and prepared fingerprint stay separate. |

`fi.fix_channels.epoch=1` and its legacy sequence slots remain their reviewed offline meaning. Actual engine sequence cursors live in an additive, versioned runtime-session mapping keyed by verified store incarnation and direction. Do not reinterpret epoch 1 as a running engine counter, reset it on reconnect, or use a new attempt/sequence number to obtain a new economic effect.

### Exact bytes and additive database change

Propose migration 009 with immutable profile/session/observation/callback correlations, forced RLS and sandbox-composite references, plus narrowly granted versioned ingress operations. Keep migrations 001–008 and historical results unchanged. Existing SDK entry points reject live-profile input; the new bridge must use the new contract explicitly.

Implement a separate runtime wire parser in TypeScript and independent SQL/Python verification. Its result has its own versioned frame type; it must not be cast into a legacy trusted decoder result or inserted into the legacy trust registry. It admits the reviewed pinned engines' header layouts while enforcing framing, BodyLength, CheckSum, duplicate/unknown tags, dictionary/selected-message rules, sender/target, timestamps, replay headers, exact strings and size bounds. The observed ordered headers, shared by both engines, define the proposed narrow allowlist:

| Frame form     | Ordered header tags before the body      |
| -------------- | ---------------------------------------- |
| Fresh          | `8,9,35,34,49,52,56`                     |
| Retransmission | `8,9,35,34,43,49,52,56,122`, with `43=Y` |

The final native run retained both forms for Java and Go with exact raw hashes. Proposed header timestamp precision is exactly three fractional digits in UTC (`YYYYMMDD-HH:mm:ss.SSS`), with real calendar validation and OrigSendingTime no later than SendingTime. Body business timestamps retain the existing accepted rules. Message body fields follow the immutable legacy `PROFILES` required/allowed sets and economic value rules, with the one explicit transport addition below; body field order may differ because it carries no economic identity. It must not infer body compatibility from the initial header error. Optional header forms not observed here require explicit profile review.

| Selected live direction/type | Proposed body/authority mapping                                                                                                                                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TRADEFLOW → ATLAS, D         | Existing D terms and original owned order UUID; additionally require standard transport field `21=1`. Its presence is validated and retained in the new profile's metadata identity, never added to a financial-kernel payload.        |
| TRADEFLOW → ATLAS, F         | Existing F contract, including actual retained dealer OrderID (37), original/cancellation UUIDs and instrument fields. Current transport F probes omit some of these and cannot be financial fixtures.                                 |
| ATLAS → TRADEFLOW, 8         | Existing 8 required/allowed fields, including TimeInForce (59), exact per-report fill quantities, retained dealer identities and status/reference rules. Current transport probes do not establish those economic prerequisites.       |
| ATLAS → TRADEFLOW, 9         | Existing 9 contract including TransactTime (60) and exact status/reason correspondence. For example, the current probe's `39=0,102=0` is not valid under the old financial rule; a new owned fixture must use a permitted combination. |

This contract selects ATLAS only, matching the actual two peer CompIDs. BIRCH/CEDAR or reversed business-message directions require a separate reviewed profile. The runtime bridge's allowlists must explicitly support the financial-valid body sets in its new mode; standalone 3C1 tests and historical probes retain their original meaning. `21=1` is a transport-profile addition, not a financial convention change. The new independent verifier must check its metadata identity without relabeling legacy message fingerprints.

Store the original observed bytes and their hashes. Never sort/re-encode a frame to make the legacy parser accept it, set `profile_valid=true` by assertion, or replace financial decimals with floating point.

The additive SQL dispatch must validate the binding's immutable profile and live callback evidence before metadata becomes eligible for preparation/application. Legacy parser/function behavior remains unchanged for legacy bindings. For live bindings, old callable routes must fail closed rather than becoming a bypass. Existing financial terms, operation mappings, kernel economics, fingerprints and atomic effect checks remain authoritative. Any required wrapper dispatch changes belong to reviewed migration 009; this proposal is not executable SQL or authorization to install it.

### Ordering and crash outcomes

1. **Outbound intent:** verify existing owned order/binding and exact semantic fields. Let the engine assign its headers and sender sequence. Hold the actual emitted frame at the private proxy; durably record its exact bytes under the original metadata request before forwarding. Backpressure preserves FIFO order: no later application or administrative frame may overtake a held frame. A held frame is not a delivery receipt.
2. **Inbound observation:** capture the exact physical frame and durably record its observation before passing it to the engine. Observed bytes are not accepted financial evidence. Administrative messages never enter financial preparation or APPLY.
3. **Validated callback:** correlate the real FromApp callback to the single in-flight application observation using connection, direction, sequence, type and exact semantic correspondence. The callback emits a bounded acceptance event and returns without waiting for SQL; persist that event under its original key before issuing the separate bridge acknowledgment and releasing the next in-flight application frame. Rejected, absent, duplicate, ambiguous or mismatched callbacks remain distinct; no synthetic callback fills a gap.
4. **Controlled application:** only a known committed eligible message may follow the existing ordered QUEUE/CLAIM/PREPARE/APPLY path. Current proof/generation/fence and original prepared payload/key remain mandatory. Apply through the existing SQL-owned atomic financial boundary; an independent snapshot/oracle must verify the observed effect.
5. **Unknown outcome:** database commit and engine store/callback progression are not atomic. On any lost acknowledgment or process kill, recover using the original request/key, retained immutable observation and verified store evidence. If the callback or commit cannot be established, mark the lane UNRESOLVED and block later work. Missing receipts are not proof of rollback; never mint a replacement financial key or reset a store to make progress.

The separate queue creates an explicit crash window: if an emitted callback event is lost before durable recording, neither an advanced engine counter nor raw observation alone repairs it. The lane remains unresolved. The response guard and shutdown controller remain independent of a blocked bridge/database operation.

The callback bridge is evidence of a controlled local synthetic process, not authenticated external provenance. An engine serializer may reorder a callback representation; it cannot replace the proxy's original raw bytes. If exact observation-to-callback correlation cannot be proved, the acceptance case fails closed.

### Replay, quota and reconciliation

A physical retransmission may have new session headers/attempt identity but must retain its logical/economic identity and exact original business values. Matching replay produces zero additional financial effects or capacity consumption; conflicting terms/ExecID/reference mappings remain unresolved. A restarted engine must reuse the verified owned store. Unverified store loss cannot be repaired by a new epoch or fresh sequence 1.

Preserve existing 512-command/1024-event financial capacity, at most four bindings, 25-command/43-event per-binding reservations, 15-second leases and the two-slot security-rotation headroom. RELEASE does not replenish financial capacity. Preserve 40 logical messages/work items per order, four physical attempts per logical message, finite unresolved-ingest limits, 960 ordinary metadata receipts plus reserved claim recovery, and current expiry/retention. New bridge mutations count toward explicit protocol quotas; independent maxima do not promise that all maxima are simultaneously attainable. Exhaustion stops new work while retaining authorized reads and original-key recovery.

Add a new hash-bound reconciliation profile and versioned report/watermarks for raw observations, validated callbacks, runtime sequence/store evidence and financial application. Retain existing financial independent queries and use an independent raw-byte/dictionary/per-fill rational oracle. Legacy foundation/application reports keep their original schema/profile meaning; they are not relabeled as live-session verification. External delivery/completeness remain false even if observed local financial application is proven.

### Required acceptance before 3C2 completion

| Case family              | Required evidence                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorized lifecycle     | Real owned order UUIDs and references through D/8/F/9, both exact-decimal conventions and BUY/SELL; observed SQL effects and independent per-fill cash/positions. Existing SYN transport probes are not financial fixtures.                 |
| Authority                | Feature OFF, viewer, wrong/cross-sandbox proof, revoked generation, expired lease and stale fence cannot prepare/apply; manual driving of bound orders remains denied.                                                                      |
| Byte validation          | Actual pinned-engine order accepted only by the new profile; legacy FIELD_ORDER controls preserved; malformed/framing/checksum/dictionary/replay-header defects rejected without normalization.                                             |
| Replay and ordering      | Duplicate and resend/gap paths, changed transport headers, reordered reports, immutable ExecID conflict and unresolved head; zero duplicate financial effects.                                                                              |
| Crash windows            | Real process kills before/after observation commit, before engine acceptance, after callback but before its acknowledgment, before/after financial commit, and after lost response; retain original keys and explicit unresolved outcomes.  |
| Storage and bounds       | Missing/corrupt/replaced store, different connection/incarnation, quota boundaries, full pipes/output and uncertain owned-resource cleanup; no silent reset or unrelated resource deletion.                                                 |
| Atomicity/capacity       | Forced rollback and commit ambiguity prove no orphan financial effect, forged consumption or fabricated protocol outcome; rotation and all current capacity invariants survive.                                                             |
| Independent verification | Deliberate isolated corruption causes findings; complete new live-bridge tests plus unchanged legacy validation, repeated browsers, two PostgreSQL runs, workstation/public-demo and all CI gates pass at the proposed implementation head. |

Phase 3C2 implementation needs its own reviewed spec, fixtures and additive migration. Later Phase 3C/Phase 4 contracts remain separate work; this proposed contract does not mark them complete.

## Builder decisions

- Direct implementation in this isolated worktree, one final whole-branch review.
  The design builder check read the prepared contract and actual SQL/SDK and
  returned "nothing important left". The owner's start instruction preserves
  authorization; no repeated workflow-choice or contract-approval prompt.
- Implement a separate `decodeLiveFix44`/`liveFix44Bytes` API and private WeakMap.
  Legacy profile validation is reused only on parsed business fields, omitting
  framing fields and the new D-only constant21; the original raw bytes are never
  re-encoded, relabeled trusted legacy frames, or replaced.
- Migration009 stores live bindings/sessions/connections, observations/callbacks
  and sequence slots. Old epoch1 slots retain only legacy metadata semantics.
  Preserve public function OIDs by inserting an asserted live-binding guard
  after authorization and before receipt lookup. Owner-only private snapshots
  retain the exact installed v8 command, ingest and application bodies. New
  narrow live functions own observation/callback admission and delegate other
  commands to those proven bodies. A live request extension binds the complete
  profile/context to existing receipts without charging another quota. New
  connection ordinals fence older incarnations; the store identity persists.
- Original SQL001-008, financial kernel/hash/effect bodies, legacy decoder,
  independent historical verifiers and all434 preservation hashes stay frozen.
- A new explicitly constructed `LiveWorkflowDatabase` subclasses the existing
  bounded database type, reuses its pool and client-lease helper and supplies its
  own schema9 transaction/compatibility path. Default database clients retain
  schema8 behavior. Cost: transaction logic duplicated in the opt-in subclass
  must be qualified against commit ambiguity, authorization and original bounds.
- New reconciliation has a distinct schema9/profile identity. Existing v2
  financial/protocol reports are not relabeled or used as live acceptance.
- Each staged frame has exactly one observation and a separately correlated
  callback; callback emission does not wait for SQL, but later application
  frames wait for the durable acknowledgment. Missing evidence stays unresolved.
- New fixtures are owned real synthetic order IDs with legacy-valid business
  terms; old SYN transport probes are negative compatibility fixtures only.

The schema9 migration lives in `db/live-migrations/009_fix_live_ingress.sql` and uses an explicit live loader. The existing default loader discovers every file in db/migrations, so putting009 there would silently upgrade the schema8 default and break its frozen clients. Cost: the live profile has a separate opt-in migration entry point.
