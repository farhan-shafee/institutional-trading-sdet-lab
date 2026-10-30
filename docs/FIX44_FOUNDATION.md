# FIX4.4 adapter foundation — Phase3B1

This is local/ephemeral-CI **metadata infrastructure**, disabled by default. There is no FIX delivery or financial application entry point. A decoded report is not a trade, and a prepared financial identity is not a committed execution. Existing public HTTP routes and the workstation do not import or enable this module.

## Verified integration preflight

The branch starts exactly at Phase3A `5afab8170791db252d2a0992c701084f44bbdf42`, tree `6d1bd9beb43ff3fef51810c92c8321f38179b9dc`. Read-only verification before branch creation confirmed open/unmerged PRs6–11 at the approved heads and continuous Git ancestry. Their heads are Phase1 `6016fb7`, Phase2A `c574710`, Phase2B `6eea6e6`, Phase2C `0efa3fd`, Phase2D `9dee9cd`, Phase3A `5afab81`. Their original bases are unchanged.

Phase3A four final-source CI workflows41136093750,41136117556,41136093712,41136117522 succeeded on first attempt. Inspected the financial kernel, independent OrderService transaction, immutable economic order, execution/source uniqueness, fill/cancel races, receipts, RLS, bounded pools, financial counters and reconciliation schemas. Migrations001–005 retain their exact reviewed checksums. No unresolved preflight blocker was carried into implementation.

The upgrade must be additive and use schema6-compatible code. Old optional-workflow binaries fail closed on a newer migration list; equity/analytics behavior when persistence is OFF remains independent of PostgreSQL. There is no production migration or deployment in this phase.

## Storage and identities

Migration006 adds fourteen owned forced-RLS business tables and two private controls:

| Relation                      | Responsibility                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| fix_channels                  | Owned fictional dealer/channel, epoch1 only; not a running session                                                               |
| fix_bindings                  | Immutable original order, accepted dealer, original ClOrdID and frozen-contract hash                                             |
| fix_lanes                     | Current owner/actor/capability generation, monotonically increasing fence,15-second lease, closure                               |
| fix_messages                  | Immutable logical message, bilateral fields and canonical semantic hash; candidate execution/source UUIDs only for Trade reports |
| fix_sequence_slots            | Channel/epoch/direction/MsgSeqNum→logical-message mapping, not economic identity                                                 |
| fix_attempts                  | Immutable physical observation/staged encoding, exact bytes, SHA256 and bounded attempt number                                   |
| fix_outbox                    | Staged delivery intent, permanently NOT_IMPLEMENTED in this schema                                                               |
| fix_dealer_correlations       | Dealer OrderID assigned only from stored inbound8 evidence, immutable thereafter                                                 |
| fix_cancel_correlations       | Cancellation ClOrdID→original order/OrigClOrdID and first immutable evidence                                                     |
| fix_work                      | Ordered per-order work, one item per logical message                                                                             |
| fix_prepared                  | Immutable original financial key/payload/hash, captured fence/generation and candidate IDs                                       |
| fix_outcomes                  | METADATA_ONLY outcomes only; financial command references are constrained NULL                                                   |
| fix_commands                  | Immutable protocol receipts and canonical request fingerprints, separate from financial receipts                                 |
| fix_events                    | Append-only protocol evidence, unique(command_seq,event_index); index0 for this phase's single-event commands                    |
| fi_control.fix_reservations   | Whole-lifecycle protected financial capacity and explicit safe release                                                           |
| fi_control.fix_writer_context | Transaction-private, owner-controlled rotation allowance; never an application-controlled GUC                                    |

All relationships use sandbox-composite keys. Cross-sandbox references cannot satisfy the FKs. Business evidence and receipts have immutability triggers. No new login role is created. `tf_app` receives narrow FIX command/read functions and scoped SELECT, no unrestricted business-table writes and no private-kernel EXECUTE. `tf_reconciler` receives read-only access to protocol records/reservations/key registry plus a proof/generation-checked snapshot authorization function. Its server credential remains outside browser code. Maintenance only purges the complete expired graph.

Original economic order UUID, original ClOrdID, dealer OrderID, cancellation UUID/OrigClOrdID, dealer ExecID, logical UUID, physical attempt UUID, channel/epoch/sequence, candidate execution/source UUIDs and financial command key remain distinct. Original ClOrdID equals the existing immutable order UUID; it never creates another order. Dealer OrderID starts absent and cannot be supplied at binding creation. ExecID uniqueness is sandbox/dealer/report scoped across retained records, not tied to sequence or channel restart.9 has no invented ExecID.

Exact bytes are hashed independently from semantic fields. The semantic canonicalizer is PostgreSQL canonical JSONB text with8,9,10,34,43,52,122 excluded. Price, quantity, business timestamps, IDs and event contents remain exact; no display rounding enters a fingerprint. Canonicalization changes require review/migration. Valid retransmission-header changes preserve logical/economic identity while producing another physical observation. Conflicting content under an existing identity rolls back safely. The approved TypeScript codec validates SDK input; independent SQL framing/term checks defend the database boundary too.

## Internal command contracts

`FixFoundationService(database)` defaults OFF; the caller must explicitly opt in with `true`. There is no environment-triggered automatic activation and no new HTTP/FIX listener. The SDK uses strict Zod input validation and the existing bounded WorkflowDatabase transaction/authorization callback. Every durable mutation requires the caller's retained Idempotency-Key and original request. Never generate replacement financial commands after uncertainty.

| Operation        | Required payload                                  |
| ---------------- | ------------------------------------------------- |
| BIND             | order_id, dealer_id, channel_id                   |
| RECORD           | order_id, raw_hex, attempt_id                     |
| CLAIM            | order_id, owner_id                                |
| QUEUE            | order_id, message_id, work_id                     |
| PREPARE          | order_id, owner_id, fence, work_id, financial_key |
| RESOLVE_METADATA | order_id, owner_id, fence, work_id                |
| RELEASE          | order_id                                          |

All fields are strings. UUIDs normalize to lower case, fingerprints use canonical JSONB plus version/sandbox/operation. A repeated key returns the original response; conflicting payload or key-domain reuse returns409. Input errors400, denied SDK read-only binding403, wrong proof/generation/ownership404, state/identity/fence conflicts409, quotas429, database/unresolved commit503 use the existing error envelope. Fixed safe errors never echo raw messages, proofs or credentials.

BIND requires an owned pristine PENDING_ACK/version1/unfilled order and its actual accepted dealer. It reserves capacity before future staging. RECORD can store the four approved message types with exact immutable terms. OUT means staged bytes, not delivery. RECEIVED means a local metadata observation, not verified network provenance. QUEUE does not create an economic order and rejectsD as a financial-creation action.

`read(...,'RECEIPT',key)` and `read(...,'STATE',order)` are authorized bounded reads. A404 FIX_OUTCOME_UNRESOLVED is **not** proof that an in-flight or queued original operation cannot still commit. Preserve and replay the original key/request. Original replay is checked before write expiry/quota/fence admission; proof/current-generation authorization still applies. No recovery capability or bearer journal is introduced.

## Ordering and transactional boundary

All business writers serialize first on their sandbox. Existing lanes are locked before order state; initial binding creation validates the pristine order while holding the same serialization root. Sequence assignment to work is durable and bounded. The lowest work item without an outcome is the head. Only the current leased actor/owner/generation/fence may prepare it or resolve protocol-only metadata. An unresolved prepared head blocks later preparation. New keys cannot rebase an already prepared payload.

Reclaim after expiry increments the fence but retains the original prepared payload, financial key and event identities. Capability rotation immediately permits a new-generation fenced claim while denying old proof/generation; logout is checked by the trusted session verifier before COMMIT. A renewed owner must inspect the retained prepared intent, not create a replacement. No application result can be marked financially applied in schema6. RESOLVE_METADATA is restricted to PROTOCOL_ONLY work and does not acknowledge, fill or cancel an economic order.

The immutable financial kernel body is copied unchanged into a private owner-only function. The original public function is replaced **at the same OID/signature**, preserving prepared statements and original-key replay. Its guarded wrapper rejects manual commands on FIX-bound orders, including local cancellation requests. The actual order/ledger/position/audit logic is still the one original kernel. Private rotation is similarly wrapped, and private writer context grants only the reviewed security-headroom allowance. No application role can invoke the private kernels directly.

A future separately approved application function must call that kernel on the same PostgreSQL connection/transaction as protocol outcome, reservation consumption and receipt recording. It must not call `OrderService.command()` and then separately persist protocol results. **No such FIX financial entry point is implemented or granted here.** Prepared-key promotion and effect-backed reservation consumption remain disabled until Phase3B2.

## Capacity proof and lifecycle

Per binding:1 acknowledgment +8 fills +8 cancellation requests +8 outcomes =25 financial commands. Actual audits:1 +8×3 +16×1 =41. Reserve43 event slots, retaining2 for the kernel's conservative +3 admission. RFQ acceptance already created the order and is not counted again. Pending-cancel protocol reports and retransmissions are metadata, not financial commands.

At most4 retained bindings/sandbox. The universal sandbox-counter trigger enforces actual financial usage plus all active reservations against512/1024 for **every** financial writer. Ordinary writers also leave2 shared command/event slots for security rotation; only an authenticated private rotation wrapper can use that allowance. The reservation budget cannot be spent by spoofing an application GUC. Rejected/unbound commands cannot silently consume protected slots; trigger errors roll back all associated financial effects. Original-key replay consumes no capacity.

Reservations stay at their whole-lifecycle allocation in Phase3B1: there is no financial consumption path. Future consumption must be linked atomically to a real kernel effect, never an arbitrary counter decrement or duplicate/rejected report. Protected release is allowed only for a pristine metadata binding with no messages and no live lease. It permanently retires the binding; it is not order cancellation and does not restore manual driving. Any uncertain/evidenced work prevents release.

Bounds:40 logical messages and40 work items/order;4 physical attempts/message;960 ordinary metadata receipts/sandbox, with up to64 remaining receipt positions reserved for CLAIM recovery; all metadata reads/original-key replay remain available at quota. These are explicit finite limits, not unlimited recovery claims. Writes end after7 days; the existing30-day retention and maintenance tombstones remain. Maintenance holds sandbox ownership and preserves a live lease, then deletes the entire expired graph, reservations and registry entries together. It never selectively erases an unresolved live intent.

## Reconciliation and recovery

Existing financial four-query coverage and stored v1/schema5 results remain unchanged. New financial manifests are v2/schema6 with six exact migration checksums. The runtime and independently authored OpenAPI accept the two distinct metadata variants; they do not relabel older results or add protocol findings to financial ledger findings.

`verification/sql/fix_foundation.sql` is an independent read-only, hash-bound metadata verifier. It reconstructs fields from immutable raw bytes and checks semantic correspondence, original contract/dealer correlation, ordered work, prepared references, capacity and protocol audit. It does not call application financial helpers. The authorized verifier uses a single repeatable-read/read-only snapshot and distinct financial command, protocol control and protocol ingest watermarks. Financial application watermark stays0; protocol completeness is NOT_IMPLEMENTED; financial ledger consistency is NOT_EVALUATED. FOUNDATIONS may be consistent while the end-to-end FIX lifecycle remains unverified. It never returns COMPLETED_CLEAN, delivery_verified=true or financial_application_verified=true. This foundation profile is not a durable replacement for existing financial reconciliation history.

Unknown metadata COMMIT is resolved by the original receipt/request under normal sandbox serialization. No in-memory fallback or fabricated success exists. Actual process kills before/after COMMIT, connection termination, server restart and session revocation are real-PostgreSQL tests. Pool-client error observation covers checked-out clients as well as idle pool errors; it does not log driver errors, retry after COMMIT or change timeout policies.

## Integration, rollback and next boundary

Review/merge bottom-up PR6→7→8→9→10→11→this branch, preserving ancestry while stacked; retarget or merge only under later explicit approval. Re-run full-stack and populated migration gates after approved integrations. The test focused on migration005 is explicitly pinned to005, preserving its original assertions; new tests cover populated005→006 and earlier-schema combined upgrades. Migration006 flushes its pending command-key FK check before changing that table and restores its initially-deferred mode, preserving all constraints.

No destructive downgrade of protocol evidence. Disable the optional SDK/feature with a schema-compatible build; preserve uncertain intents and keys for review. Previous optional-workflow binaries intentionally reject unknown migrations. The existing public demo/infrastructure is unchanged and no release is authorized here.

Phase3B2 requires separate approval for protocol-to-kernel application, exact canonical idempotency promotion, effect-backed reservation consumption, fill/cancel validation and atomic outcomes/ledger reconciliation. No sockets/session engine, actual delivery, FIX financial effects, settlement, live counterparties, hosted provisioning or paid service is included now.
