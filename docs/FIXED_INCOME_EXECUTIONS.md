# Phase 2C: order lifecycle, execution ledger and derived positions

Candidate source only. Synthetic local simulator, feature default OFF. No production, hosted database, FIX, brokerage, settlement, clearing, P&L, available cash balance or deployment capability is added. Existing equity endpoints and session books remain separate.

## Economic contracts and records

Migration `004_execution.sql` is additive. Migrations 001–003, existing quotes, `fi.orders.status='PENDING_ACK'`, and both immutable financial triggers remain unchanged. That status is the **initial contract status**, not a current lifecycle projection. Existing RFQ reads and already-completed receipts retain their original shape and exact frozen terms. New order reads contain that original contract plus a separate `lifecycle`.

| Table                      | Ownership/key and role                                                                                                                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fi.order_states`          | `(sandbox_id,order_id)`; controlled current status/version, filled and remaining executable par, total executed positive cents, execution count, pending cancellation ID and decision/recording times                                                                       |
| `fi.order_history`         | Immutable `(sandbox_id,order_id,version)` snapshots; contiguous version ordering and command references for every subsequent transition                                                                                                                                     |
| `fi.executions`            | Immutable `(sandbox_id,id)`; unique sandbox source-event ID and `(sandbox_id,order_id,fill_sequence)`; exact par, contract price/revision/date/side, accrual fraction inputs, positive integer cents, immutable command and audit references, decision/recording timestamps |
| `fi.cancellation_requests` | Immutable sandbox-scoped ID, parent order, request sequence (1–8), command reference and timestamps                                                                                                                                                                         |
| `fi.cancellation_outcomes` | Immutable one-per-owned-request outcome/reason, parent order, command reference and timestamps                                                                                                                                                                              |
| `fi.positions`             | `(sandbox_id,instrument_revision)`; signed executed par/cash, execution count, last execution command and update time; execution-derived projection                                                                                                                         |

Every relationship to an owned order/request/command uses composite sandbox keys. Executions reference the immutable order, so its exact instrument definition, original settlement, dealer price and both model versions remain authoritative. Instrument revisions themselves are immutable. No independent economic position creation exists. Net-zero positions retain execution counts and signed execution cash.

An initialization trigger adds version-1 PENDING_ACK state/history when a contract is accepted. The migration backfills existing contracts without rewriting any order, quote, audit event or completed receipt. Initial history references its immutable parent contract; subsequent history references its immutable command. No positions are created at acceptance or acknowledgment.

All six new tables force RLS. `tf_app` receives SELECT and only three new executable entry points: `order_command`, `read_orders` and `read_positions`. It receives no INSERT/UPDATE/DELETE/TRUNCATE rights or private calculator/body-helper access. Definers have fixed search paths and qualified relations. Existing migration/maintenance/reconciliation role boundaries remain. The owner can alter guards; this is not WORM storage or protection against a fully compromised application credential.

## Transitions and versions

| Command                                     | Preconditions                                                       | Result                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| ACK_ORDER                                   | PENDING_ACK, current version                                        | NEW                                                                                               |
| REJECT_ORDER                                | PENDING_ACK, current version                                        | REJECTED, zero executable remainder                                                               |
| EXECUTE_ORDER                               | NEW or PARTIALLY_FILLED, current version, positive par <= remainder | PARTIALLY_FILLED or FILLED; one immutable execution and signed position/cash update               |
| REQUEST_CANCEL                              | NEW or PARTIALLY_FILLED, current version, no pending request        | Separate PENDING cancellation; order remains executable                                           |
| ACK_CANCEL                                  | Matching pending request, current version                           | CANCELED if still executable; preserves all filled par/cash and removes only executable remainder |
| REJECT_CANCEL                               | Matching pending request, current version                           | REJECTED cancellation outcome; order remains executable                                           |
| ACK_CANCEL or REJECT_CANCEL after full fill | Matching pending request, current version                           | FILLED remains; cancellation outcome REJECTED/TOO_LATE, pending reference cleared                 |

Successful lifecycle transitions increment version once; rejected commands and source-event duplicates do not. Versions are string integers. A deferred integrity checker reconstructs filled par/cash/count and positions, checks frozen execution terms/cash, contiguous fill sequences/history and audit linkage. A transition trigger prevents reopening terminal rejected/canceled orders; a FILLED order can only resolve its already-pending cancellation while remaining FILLED. SQL role privileges are the business-write boundary.

Every order accepts at most eight fills. With seven committed fills, the eighth must consume the entire remaining par (`FILL_LIMIT_REQUIRES_REMAINDER`). This avoids an executable remainder that the fill bound would strand. At most eight cancellation requests are admitted per order (`CANCEL_REQUEST_LIMIT`). One pending request at a time is allowed. There is no amendment, correction, bust, replacement or reopening command.

A too-late cancellation outcome returns HTTP 200 with explicit `state:REJECTED,reason:TOO_LATE`; this acknowledges recording the simulated **outcome**, not successful cancellation. A stale expected version returns 409 and requires an explicit state review; no command is automatically rebuilt with a new key/version.

## Exact fill cash

Both Phase 1 regular coupon contracts are preserved: USD, coupon 0.04 annually, semiannual, dated 2025-01-15, first coupon 2025-07-15, maturity 2031-01-15. Dates are unadjusted; settlement must remain before maturity. Treasury accrual uses Actual/Actual ICMA; corporate uses US/NASD 30/360. Coupon-date elapsed accrual is zero. Day counts operate on Gregorian dates; no time-of-day or business-day shift is inferred.

The database validates the frozen source `6016fb700840d081fe1fba651c918f0a7e709383`, exact instrument terms and valuation model `phase1-regular-coupon-v1`. Its accrual helper is deliberately bounded to these approved regular Jan15/Jul15 instruments; all starts are the 15th, so US30/360 start-EOM and conditional end-31st adjustments cannot be triggered by this contract. Phase 1's general financial implementation and independent reference cases remain unchanged.

Let exact clean price be P per100 par, fill par Q USD and coupon elapsed/period E/D. Dirty consideration in **cents** is `Q * (P + 2*E/D)`. The 100-par price and 100-cents/dollar factors cancel. PostgreSQL constructs an integer numerator/denominator using the exact twelve-place P and two-place Q, then uses integer division/remainder and HALF_EVEN. It rounds exactly once for each execution. No finite-precision approximation or JavaScript Number computes financial values.

Each fill par is 0.01–1,000,000,000.00 USD; aggregate fills cannot exceed the accepted order. Integer cents are positive, stored as bigint and serialized as decimal strings. BUY adds par and subtracts cents; SELL subtracts par and adds cents. Position totals sum actual committed fills, including each fill's individual rounding. At the Treasury ask 100.050000000123 on a coupon date, two 50.00-par fills each round to 5003 cents, totaling 10006; one hypothetical 100.00 fill rounds to 10005. There is no whole-order cash estimate used for reconciliation.

## Transactions, identity and uncertain outcomes

The existing checked-out client, bounded pool/admission, statement/lock/deadline limits and precommit session verifier are preserved. Lock order is sandbox then lifecycle row; the immutable order is read without an economic-term write lock. All writers already serialize on their owned sandbox. Database `clock_timestamp()` after lock acquisition decides write expiry. A rotating capability generation is checked after that sandbox lock.

Each accepted fill commits one execution, state/history, signed position/cash, exactly three contiguous audit events (EXECUTION_RECORDED, ORDER_STATE_CHANGED, POSITION_UPDATED), and its completed receipt in one transaction. Other successful lifecycle commands emit one event. Rejections emit one COMMAND_REJECTED event. Multi-event pagination remains `(command_seq,event_index)` with the existing fixed command watermark. Every new mutation conservatively reserves three audit slots and one command slot **before** changing financial state; quotas cannot split a financial transaction.

All durable commands require the existing sandbox-scoped Idempotency-Key. Fingerprints include method, action, sandbox, owned order and normalized strict body. Decimal par is normalized to two places and UUIDs to lowercase. Current authorization/proof/generation checks precede receipt lookup; receipt replay precedes expiry, version and capacity checks. Identical requests replay original status/body. Conflicting keys return 409 IDEMPOTENCY_KEY_REUSED.

Execution identity consists of sandbox source-event ID plus execution ID, parent order and exact par. A new command key for that same identity/economics returns HTTP 200 with the original execution, the current lifecycle and a duplicate receipt/event; no financial mutation or lifecycle version occurs, even if the submitted expected version is stale. Reusing the source with another execution ID/order/par returns SOURCE_EVENT_CONFLICT. Reusing an execution ID with another source returns EXECUTION_ID_CONFLICT. Contract economics cannot be supplied/changed in a fill request.

OUTCOME_UNKNOWN and database/network outages preserve the original request/key. Original-key replay or the existing command-receipt GET resolves the authoritative result after current authorization is restored. No replacement financial command or in-memory fallback is created. Missing/rotated/expired binding and admission errors are not evidence that a retained command failed. The inherited repeatable-read admission boundary is preserved: an already-admitted read may finish across rotation.

## REST contracts

Prefix: `/api/fixed-income/v1/sandboxes/{sid}`. Reads require an authorized read/trade binding. Mutations additionally require trader role and trade scope. All command bodies require string `expected_version`; unknown fields/query parameters reject. Zod and independently authored OpenAPI describe actual responses.

| Method/path                                             | Body/result                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| GET `/orders`                                           | At most 50 order summaries with current lifecycle                                                                   |
| GET `/orders/{oid}`                                     | Immutable order contract, lifecycle, bounded immutable history, executions and cancellation request/outcome history |
| POST `/orders/{oid}/acknowledgment`                     | `{expected_version}` → 200 compact command result                                                                   |
| POST `/orders/{oid}/rejection`                          | `{expected_version}` → 200 compact command result                                                                   |
| POST `/orders/{oid}/executions`                         | `{expected_version,execution_id,source_event_id,par_amount}` → 201 new fill or 200 source duplicate                 |
| POST `/orders/{oid}/cancellation-requests`              | `{expected_version,cancel_id}` → 201 pending request                                                                |
| POST `/orders/{oid}/cancellations/{cid}/acknowledgment` | `{expected_version}` → 200 recorded cancellation outcome                                                            |
| POST `/orders/{oid}/cancellations/{cid}/rejection`      | `{expected_version}` → 200 recorded rejection outcome                                                               |
| GET `/positions`                                        | At most two revision-keyed execution-derived signed par/cash/count records                                          |

Execution history is included in order detail; there is no redundant second execution-list endpoint. Command responses are compact `{order_id,lifecycle,execution?,cancellation?}` to preserve the existing 8192-byte immutable receipt bound. Order-detail histories are bounded to 26 versions, eight fills and eight cancellation requests. All HTTP errors retain the established envelope: 400/413/415 input, 401 session, 403 binding/role, 404 missing/foreign/revoked identifiers, 409 state/version/identity/key/expiry, 429 admission/quota and 503 persistence/schema/uncertain outcome. Transport-level failures remain distinct.

## Workstation and secrets

The existing RFQ panel adds a lifecycle/execution section for its accepted order, with explicit synthetic acknowledgment/business-rejection, fill and cancellation controls. It shows exact par/cents, immutable executions, cancellation outcomes and signed execution-derived positions. The four existing equity tabs and analytics remain unchanged. No browser capability creation, recovery or rotation is added.

The shared sandbox-scoped non-secret command journal now accepts strictly validated lifecycle requests as well as RFQ requests. It retains event IDs, original request and key before submission; an unresolved command blocks competing mutations in that sandbox. Retry sends exactly those retained values. Malformed success, network loss, 503, authorization failure and admission 429 preserve the entry. Only validated success or established definitive state/database-quota outcomes resolve it. SessionStorage remains tab-scoped, not a power-loss/closed-tab recovery promise. Browser traces/screenshots/video for workflow tests remain disabled; no recovery capabilities, headers or private descriptors are written into artifacts.

## Verification and rollback

`verification/python/execution_reference.py` independently uses standard-library Fraction, a chronological coupon schedule and literal rounding/day-count cases. It receives actual database read JSON over stdin and imports no TypeScript. `verification/sql/executions.sql` independently reconstructs quantities, signed cash/par/counts, fill cash by integer-rational math, immutable terms, audit linkage, history and cancellations from ledger/contract records. It calls no application or database calculator helper. Controlled projection and matching-ledger-cash defects are injected only inside rollback-only privileged test transactions and must produce reconciliation violations.

Mandatory gates remain full validate/legacy repeat, two fresh actual PostgreSQL runs, and three-engine workflow normal/repeat with zero retries. Tests include migration of a populated 003 database; 20 independent-connection fills/duplicates; deterministic PostgreSQL lock barriers for partial/full fill versus cancel commit ordering; transaction faults, real process/connection termination around COMMIT, database stop/restart, session logout/capability rotation, actual role/RLS isolation, quota and full retained-graph cleanup. No proposed test result belongs to this document; actual revision-specific results belong in the PR completion report.

No runtime dependency or paid service is added. Local PostgreSQL and existing CI runner compute are consumed. Existing retention/capacity (7-day writes, 30-day recovery, 50 sandboxes, 50 RFQs per sandbox, 512 commands, 1024 events) remains. Cleanup deletes the new retained graph in the same authorized maintenance transaction. Runtime never migrates automatically. Exact checksums require an explicitly compatible writer; an enabled old Phase 2B writer fails closed on 004. Rollback is feature OFF and retention of the database, followed by a reviewed compatible artifact. Do not reverse migrations or delete financial records to run an older enabled writer.

Remaining limits: synthetic public-fixture authentication, no live venue/dealer interoperability, no execution correction/bust, no economic netting beyond signed aggregates, no throughput/HA/restore/regulatory-retention certification. Phase 2D, FIX and settlement require separate approval.
