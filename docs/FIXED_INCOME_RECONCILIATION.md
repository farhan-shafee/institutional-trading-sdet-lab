# Durable synthetic reconciliation — Phase 2D

This opt-in local/ephemeral-CI simulator independently assesses retained fixed-income records. It is not a venue, broker, clearing system, settlement service or financial repair tool. Earlier phase contracts and migrations 001–004 remain unchanged. The existing workflow flag defaults OFF; without it there is no PostgreSQL requirement or equity/session change. No production infrastructure is changed.

## Boundaries and files

- `db/migrations/005_reconciliation.sql`: additive run, finding, event, receipt, capacity and shared-key registry objects, forced RLS, narrow functions, retention integration.
- `app/domain/workflow/reconciliation.ts`: strict runtime schemas; independently authored `contracts/openapi.yaml` supplies wire schemas.
- `app/server/reconciliation/`: manifest, bounded connection wrapper, snapshot scanner, worker orchestration, application facade and routes.
- `verification/sql/{foundation,rfq,executions,reconciliation}.sql`: four hash-bound independent verifiers. The first three are unchanged; the fourth adds typed comparisons with expected/observed evidence. No TypeScript calculator or application financial SQL helper is called.
- `scripts/reconcile.ts`: independently executable native local service, using retained private ownership and operation journals.
- `app/public/reconciliation.ts`: investigation inside the existing authorized RFQ workstation. No browser ownership bootstrap, recovery-capability storage, repairs or automatic resolution.

## Ownership, schema and privileges

Every public control record has a sandbox owner. Composite keys/FKs relate `(sandbox_id, run_id)` findings/events to their run, and run request references to their immutable metadata receipt. UUID run IDs are client generated; ascending `run_no` is bounded to 20 per sandbox.

| Relation                             | Purpose                                                                                                          | Protection                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `fi.reconciliation_runs`             | Source metadata, state/version, worker lease, snapshot/watermark, coverage, count, report fingerprint and timing | Controlled transitions; terminal results immutable                             |
| `fi.reconciliation_findings`         | Ordinal, category/code, affected record, related identities, independent expected and recorded values            | Append only; max 128/run; immutable                                            |
| `fi.reconciliation_events`           | Contiguous per-run state events, decision time, reason and report hash                                           | Append only; 1–3 events/run                                                    |
| `fi.reconciliation_commands`         | Original key/fingerprint, actor, metadata receipt sequence, exact stable response                                | Immutable completed receipt; max 64/sandbox                                    |
| `fi_control.reconciliation_capacity` | Metadata receipt count and reserved interruption-recovery slot                                                   | Private; sandbox lock; deferred consistency                                    |
| `fi_control.command_keys`            | Shared sandbox/key namespace across financial and reconciliation commands                                        | Private; existing financial keys backfilled; uniqueness enforced before insert |

The metadata control plane does **not** write `fi.commands`, financial audit history or financial capacity counters. This is necessary to investigate corruption of those very records without weakening their existing deferred financial invariants. Metadata receipt sequences are distinct from financial command watermarks. Cross-domain key collisions return controlled 409 and roll back the entire attempted financial command.

All owned tables force RLS. `tf_app` has scoped SELECT and narrow request/read/recover functions, no business-table write grant, and cannot record a report. Server-only `tf_reconciler` retains SELECT-only financial access; only its narrow claim/finish functions can write reconciliation metadata. It cannot repair financial records. `tf_owner` remains NOLOGIN; reviewed functions fix their search path. The trusted local reconciler credential is a service credential, not a user credential: direct SQL SELECT can inspect all retained synthetic sandboxes. The server must protect it, scope every query and authorize every command. Browser clients never receive that credential.

## Lifecycle and atomicity

`REQUESTED(v1) → RUNNING(v2) → COMPLETED_CLEAN | COMPLETED_WITH_FINDINGS | INCOMPLETE | FAILED(v3)`.

An unclaimed expired request can transition directly to `INCOMPLETE(v2)`. Engine mismatch at claim produces `FAILED`. A terminal state cannot reopen. A newer assessment always has a new run ID and original command key, after the previous request is definitively resolved.

1. Validate current trader session, trade-capability binding/generation, strict request and key. Reserve/replay the global key and metadata receipt under the sandbox row lock. Atomically persist REQUESTED run, initial event and stable request receipt.
2. Separately claim under the same ownership lock with a unique worker ID and 15-second lease. Record RUNNING event. At most one run is active per sandbox.
3. In one `REPEATABLE READ READ ONLY` transaction, capture PostgreSQL snapshot ID, database timestamp and actual maximum committed **financial** `fi.commands.command_seq`. Execute all four reviewed SQL queries in this snapshot. Read and authenticate only; no financial or metadata writes occur in verification.
4. In a separate short transaction, recheck current capability/generation/session and worker lease, validate declared hashes/coverage/outcome, insert bounded findings, set terminal result and append completion event atomically. A failure rolls back all result effects. Never declare clean before this commit.

Each verifier records COMPLETE, FAILED or NOT_RUN, query hash and total discrepancies. Clean requires all four COMPLETE, valid snapshot/watermark and zero findings. SQL failure/timeout is FAILED; finding overflow is INCOMPLETE/FINDING_LIMIT, retaining the first 128 with the total known count. An expired worker is INCOMPLETE even if its calculations finished. No partial scan or partially persisted result is clean. The report hash is SHA-256 of PostgreSQL's canonical JSONB report serialization.

Financial state may advance during verification. Every result is a **historical/as-of assessment**, not proof of the latest ledger. Reads separately report the currently observed financial command sequence and latest completed run identity. A snapshot does not incorporate later commits and is never resumed on a new snapshot after process failure.

## Independent financial checks

Expected quantities/cash/counts come from authoritative immutable execution rows and order contracts, not from state/position projections. The independent SQL reconstructs per-order filled par, remaining executable par, recorded fill cash, signed positions and counts (including net zero), sequence/reference integrity, history/audit/receipt links and cancellation consistency. It checks RFQ acceptance cardinality, original exact dealer bid/ask grid, frozen contract equivalence and pinned Phase 1 source terms.

Cash reconstruction uses literal approved instrument definitions, coupon schedule 2025-01-15 through 2031-01-15 at six-month intervals, 4% coupon, Actual/Actual ICMA or US/NASD 30/360 as applicable. It uses integer-scaled NUMERIC ratios, quotient/remainder HALF_EVEN, exact 12-decimal contractual clean price, accepted settlement date and par. Coupon boundaries and permitted settlement domain remain those of Phase 1. It rounds once **per execution** and sums committed fill considerations. It does not equate separately rounded partial fills to a hypothetical full-order execution. The unchanged independent Python oracle continues to verify both conventions, leap years, boundary rounding and actual committed partial executions; it imports no TypeScript finance implementation.

Detailed findings include category/code, record kind/ID, expected/observed decimal strings or integer-cent strings, and related RFQ/quote/order/execution/command identities where relevant. Existing coarse SQL guard findings are also retained with the original check's evidence so richer checks cannot hide an older invariant failure. A later clean run cannot erase any earlier finding.

## API contracts

All paths use `/api/fixed-income/v1`. Existing equity endpoints are unchanged. All mutation bodies reject unknown fields and require `Idempotency-Key`.

| Method/path                                               | Body/query                                       | Result                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| GET `/reconciliation/status`                              | None                                             | Authenticated `configured` boolean; no credentials                                     |
| POST `/sandboxes/{sid}/reconciliation-runs`               | `{run_id: UUID}`                                 | 201 stable run reference; Location; synchronous bounded attempt to complete            |
| GET `/sandboxes/{sid}/reconciliation-runs`                | `limit` 1–20; `after`; pinned `as_of`            | Ascending run keyset page plus current financial watermark/latest completed ID         |
| GET `/sandboxes/{sid}/reconciliation-runs/{rid}`          | None                                             | Historical run, source, coverage and contiguous state events                           |
| GET `/sandboxes/{sid}/reconciliation-runs/{rid}/findings` | `limit` 1–20, `after` ordinal, optional category | Immutable ordinal keyset page                                                          |
| POST `/sandboxes/{sid}/reconciliation-runs/{rid}/recover` | Strict `{}`                                      | 200 stable reference; expired active run becomes INCOMPLETE; terminal result unchanged |
| GET `/sandboxes/{sid}/reconciliation-commands/{key}`      | None                                             | Authoritative immutable original metadata receipt                                      |

The normal error envelope and 400 validation, 401 session, 403 role/binding, 404 owned-resource, 409 conflict/state/expiry, 429 admission/quota and 503 unavailable/uncertain semantics remain. Viewer/read bindings inspect only; trader+trade binding requests/recovery. Revoked generations fail closed. Repeated/unknown query parameters are rejected. A replay returns the exact original request reference, **not a fabricated new verification**; GET detail is authoritative for completion.

## Idempotency, uncertain outcomes and recovery

Native and browser command journals retain run ID, original key and normalized request **before** submission. Only the native private ownership journal contains capabilities. Browser journal contains validated non-secret synthetic command fields and shares the prior RFQ/order journal, blocking competing mutations until resolution.

Identical sandbox/key/fingerprint replays; conflicting payload or key domain returns 409 without replacing history. A replay may claim an unstarted REQUESTED run, but never reruns a RUNNING/terminal run. Source metadata is captured at service initialization; a changed engine cannot claim an earlier request. Reviewed SQL bytes are hash checked before scanning. Provenance requires the Git checkout; unavailable metadata fails 503. A DIRTY tree is explicitly labeled and never represented as reviewed clean source.

On uncertain transport/COMMIT, retain the original request/key; inspect receipt and run or retry the original command. Do not generate a replacement command. A completed result survives app/database restart. Crash after snapshot or before result COMMIT leaves RUNNING with no partial terminal record; after lease expiry explicit original-sandbox recovery marks INCOMPLETE. Crash after result COMMIT preserves the exact result. No in-memory fallback. One metadata receipt slot is reserved while active, so repeated rejected requests cannot starve interruption recovery.

## Resource bounds, retention and infrastructure

- One active run and 20 retained runs per sandbox; 128 findings/run; 64 metadata receipts/sandbox including durable definitive rejections, with one recovery slot reserved while active.
- Four fixed queries, bounded rows/materialized evidence, 15-second lease. Reconciler pool max 2, queue admission max 4; 500ms connection, 750ms lock, 1500ms statement, 2000ms idle-in-transaction and 5-second transaction deadline. Existing app pool/admission bounds preserved.
- Existing seven-day write / thirty-day retention remains. Authorized maintenance preserves live request/worker leases and deletes all expired owned records, keys and capacity atomically; repeated CI executions return retained capacity to zero. There is no new daemon.
- Optional `TRADEFLOW_FIXED_INCOME_RECONCILER_URL` must identify `tf_reconciler` on the exact same owned loopback database/port/path as app, without URL query/hash. `db:local serve` supplies the private owned role URL. No URL is printed or sent to UI.
- Independent native execution: `npm run reconcile:local -- OWNER_FILE OWNERSHIP_JOURNAL OPERATION_JOURNAL [create|recover [RUN_ID]]`. Retain the operation journal unchanged for replay; use the latest securely retained ownership journal. The operation journal is owner-only, fsynced before submission. CLI outputs safe result evidence only; errors omit connection/ownership material.
- Local native PostgreSQL and fresh CI-owned PostgreSQL only. No runtime dependency or hosted resource added. CI splits workstation and persistence jobs without removing gates, expanding timeouts or enabling retries. Incremental monetary infrastructure cost is zero; CI runtime and bounded retained disk/CPU usage increase. No paid service is required.

## Upgrade and rollback constraints

Apply additive 005 only to owned disposable local/CI databases using the existing migrator. Populated Phase 2C upgrade verifies orders, executions, projections, receipts, audit and previous checksums unchanged and shared keys backfilled. Schema compatibility requires all five reviewed checksums. Never edit 001–004.

Application rollback to older source cannot safely operate an upgraded schema because its compatibility check rejects schema revision 5. Disable the feature first; equity remains available. For disposable local environments stop/destroy the exact owned database and recreate from the approved revision. Retained reconciliation evidence is lost on destruction; retain approved safe reports beforehand when needed. No destructive down migration or automatic database downgrade is provided. No production rollout is authorized.

## Verification and retained failure history

Tests cover real role/RLS/composite ownership, quotas/reserved recovery, immutable results, populated upgrade, standalone CLI, strict HTTP/OpenAPI, defect detection, 20 concurrent requests, stable snapshots with concurrent fills, failed SQL coverage, overflow, result rollback, SIGKILL before/after result COMMIT and between stages, lost response/application restart, database outage/restart, rotation/logout and retained historical evidence. Browser cases cover clean provenance, category/evidence/trace investigation and historical preservation, original journal replay after a lost response, and viewer read-only access in all three engines. Proposed checks are not evidence until their actual run is recorded in the PR report.

Meaningful development failures retained in ignored local logs and summarized in the PR:

- Missing-schema/route/contract tests failed before corresponding implementation.
- A NULL coverage status initially slipped through SQL three-valued logic; explicit non-null/enum validation fixed it.
- Damaged financial audit counters initially prevented reconciliation requests; separate metadata receipts/key registry resolved this without weakening financial guards.
- Reconciler metadata SELECT grants and normalized UTC timestamps were missing; real SQL/API tests exposed both and narrow fixes resolved them.
- A quote-evidence test required independent original-price values, not only a coarse violation flag; literal grid comparison added.
- Future pagination bound initially accepted; now rejected.
- Metadata receipt exhaustion could starve crash recovery; reserved slot and deferred consistency added after a failing quota test.
- Recovery tests exposed invalid privileged fixture setup (counter relation/base64 capability format), corrected without changing product expectations.
- Empty `required: []` violated OpenAPI 3.0 despite runtime validation; removed that invalid schema keyword.

Known scope limits: only the two approved regular-coupon USD instruments and pinned synthetic dealer grid; historical bounded assessments; no automatic retry/resume/repair; no background scheduler; trusted local reconciler; no independently provable defense against an administrator replacing all source records and verification code together. Full ledger conservation/financial checks are independent SQL, not formal proof. Human review of behavior and generated tests remains required before acceptance.
