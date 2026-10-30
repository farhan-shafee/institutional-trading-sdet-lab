# Phase 2B: dealer RFQs and atomic quotation acceptance

This unmerged candidate extends the Phase 2A ownership foundation, starting exactly at `c57471079774b32c82150b9a133b2a6911b8c138`. It is a synthetic institutional workflow, available only in the explicitly enabled local/ephemeral PostgreSQL mode. Feature OFF preserves the existing equity session model and stateless Phase 1 analytics without a database. No deployment or hosted infrastructure is included.

The lifecycle ends at a persistent **PENDING_ACK** order. There are no acknowledgments, executions, partial fills, positions, FIX messages, settlement processing, live data, brokerage links or external model/AI trading decisions.

## Instruments, units and quotation model

The two Phase 1 fictional instruments and all original financial formulas/conventions remain unchanged. `fi.instrument_versions` retains revision 1 and financial source `6016fb700840d081fe1fba651c918f0a7e709383`. Orders freeze that revision and its complete stored terms: USD, 4% annual coupon, semiannual, dated 2025-01-15, first coupon 2025-07-15, maturity 2031-01-15, and Actual/Actual ICMA or US 30/360 respectively. See [the Phase 1 conventions](FIXED_INCOME_CONVENTIONS.md).

Quantity is **USD par**, not bond count or cash consideration: 1 through 1,000,000,000, with at most two decimal places. It is validated before conversion and stored as PostgreSQL `numeric(12,2)`; wire snapshots use two-place decimal strings. The client explicitly supplies an unadjusted settlement date in 2025-01-15 through 2031-01-14. No automatic business-day, holiday, T+1 or accrued-cash settlement rule is implied.

`synthetic-dealer-grid-v1` is a declared **invented clean-price grid**, not a market/yield prediction model. Dealer quotes are generated server-side with exact PostgreSQL decimal arithmetic; callers cannot submit prices. Every price below is contractual **per 100 par**, stored and returned as the exact twelve-place string. No display rounding feeds acceptance.

| Instrument    | Fictional dealer | Bid             | Ask              |
| ------------- | ---------------- | --------------- | ---------------- |
| SYN-UST-2031  | ATLAS            | 99.950000000123 | 100.050000000123 |
| SYN-UST-2031  | BIRCH            | 99.940000000123 | 100.060000000123 |
| SYN-UST-2031  | CEDAR            | 99.930000000123 | 100.070000000123 |
| SYN-CORP-2031 | ATLAS            | 98.950000000123 | 99.050000000123  |
| SYN-CORP-2031 | BIRCH            | 98.940000000123 | 99.060000000123  |
| SYN-CORP-2031 | CEDAR            | 98.930000000123 | 99.070000000123  |

BUY accepts the dealer **ask**; SELL accepts the **bid**. An immutable quote snapshot freezes both prices, side, quantity, settlement date, instrument/source/terms, dealer, quote/RFQ IDs, quotation/expiry times, units and model version. The immutable order contract is that snapshot plus the exact selected `clean_price`. Both quotation `model_version` and `valuation_model_version: phase1-regular-coupon-v1` are explicit, alongside the exact financial source commit. Phase 1 output prices have ten display places; these output values do not replace the twelve-place contract.

Independent Python uses six literal bid/ask pairs, rather than the SQL grid formula, to check actual accepted HTTP snapshots. It independently inverts the contractual clean price using the existing Python financial oracle. The original Python calculations, goldens, leap-year/coupon/day-count/negative-yield cases remain intact.

## Records and ownership

Migration `003_rfq.sql` is additive; 001 and 002 are unchanged. It adds:

- Frozen global `fi.dealers` with exactly three explicitly fictional counterparties.
- `fi.rfqs`, composite primary key `(sandbox_id,id)`, frozen economic inputs, aggregate version, database timestamps and accepted quote reference.
- `fi.invitations`, primary key `(sandbox_id,rfq_id,dealer_id)`, referencing the owned RFQ and one allowed dealer.
- Immutable `fi.quotes`, unique per invitation, with composite ownership references and immutable terms.
- Immutable `fi.orders`, unique per owned RFQ and per owned quote, constrained to `PENDING_ACK` and the exact owned quote relationship.

All four sandbox tables have **forced RLS**, owner/app/reconciler policies and composite sandbox foreign keys. `tf_app` receives SELECT and only two new security-definer entry points: `rfq_command` and `read_rfqs`. It receives no table-write, trigger, migration, maintenance or private helper privilege. Search paths are fixed, names are qualified, and PUBLIC function execution remains revoked by the existing default privilege policy. The reconciler remains read-only. Maintenance purge now removes expired RFQ/order/quotation graphs before foundation records, in the same transaction.

The existing trust boundaries remain: RLS is defense against context/ownership errors, not total compromise of the app credential; the database owner can alter guards. Already admitted repeatable-read snapshots may finish across rotation. This is not WORM storage or a regulated venue.

## State and version contracts

| Aggregate      | Permitted transitions                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| RFQ            | OPEN → ACCEPTED or EXPIRED                                                                                         |
| Invitation     | INVITED → QUOTED or DECLINED; QUOTED → WITHDRAWN                                                                   |
| Quote snapshot | Immutable; effective QUOTED/EXPIRED/WITHDRAWN/ACCEPTED/UNAVAILABLE status derives from RFQ, invitation and DB time |
| Order          | Created as PENDING_ACK; no subsequent transition exists                                                            |

Invitation lists must be explicit, nonempty, unique subsets of ATLAS/BIRCH/CEDAR. Uninvited, second and terminal responses reject. A trader operates clearly labeled **simulated dealer controls**; this is not authentication as an actual dealer. There is one response per invitation and no quote replacement/requote model in this milestone.

RFQs expire 300 seconds after creation. A firm quote expires at the earlier of RFQ expiry and 30 seconds after its response. Reads project expiry using the database clock without manufacturing a command. A command observing an expired OPEN RFQ persists EXPIRED plus an expiry event and rejection receipt. A terminal RFQ does not reopen. Quote expiry leaves the RFQ open for other still-invited responses; expired/withdrawn/declined quotes cannot be accepted.

Every response, withdrawal, acceptance or persisted RFQ expiry increments RFQ version. Commands require a string `expected_version`; stale versions reject without automatically resubmitting a different economic action. The first accepted quote prevents every competing acceptance. No RFQ cancellation or order cancellation is exposed.

## Atomic transactions, locks and idempotency

All writes use the existing checked-out client/transaction/precommit session verifier. Lock order is **sandbox → RFQ → invitation**; foundation creation/purge additionally take the capacity row first. Per-sandbox serialization also orders capability rotation and prevents quota races.

Acceptance reads `clock_timestamp()` **after acquiring all required locks**. It verifies ownership proof/generation, firm invitation, OPEN state, current version, RFQ/quote expiry and capacity, then performs one transaction containing:

1. RFQ ACCEPTED state, selected quote and new aggregate version.
2. Exactly one PENDING_ACK order with frozen quote terms and selected ask/bid.
3. One completed immutable command receipt with the original response.
4. QUOTE_ACCEPTED, RFQ_ACCEPTED and ORDER_CREATED events with indices 0, 1 and 2.

Unique keys and deferred acceptance constraints reject a missing order, wrong selected quote or contract mismatch. Rollback/crash before COMMIT leaves no acceptance/order/receipt/events. A committed response lost to the client is resolved/replayed with the original retained key and normalized request. A replay returns the original status/body and `Idempotency-Replayed: true`, including after expiry or application/database restart, subject to current authorized ownership.

Keys remain sandbox-scoped across every operation. Request fingerprints include method, action, sandbox, RFQ and normalized body. Quantity, lowercase UUID and sorted invitations are canonicalized. Current proof/scope/generation precede receipt lookup. A conflicting key returns 409 and never replaces a receipt. Commit uncertainty remains `503 OUTCOME_UNKNOWN`; it is never interpreted as proof of failure. Only the foundation's bounded precommit deadlock/serialization retries exist; browser tests use zero retries.

## Audit event ordering

The original unique `(sandbox_id,command_seq,event_index)` key now allows event indices 0–2. Existing ownership events retain index zero and ownership-generation uniqueness. Events additionally reference the same `(sandbox_id,command_id,command_seq)` tuple, preventing mixed command identities.

Signed audit cursors now advance by **both command sequence and event index**, ordered lexicographically. The first page pins the upper committed command sequence. A page ending after the first event of a three-event command resumes at its second event; later committed commands remain outside that pagination snapshot. Existing cursor expiry, sandbox/limit binding, authentication and restart invalidation remain. The response's `as_of_seq` is the command watermark, not an event count.

## REST API

Existing ownership and equity routes remain. The new prefix is `/api/fixed-income/v1/sandboxes/{sid}/rfqs`:

| Method/path                    | Body / result                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| GET `/`                        | At most 50 owned RFQ summaries; no fabricated empty list during outage                            |
| POST `/`                       | `{rfq_id,instrument_id,side,par_amount,settlement_date,invited_dealers}`; 201 detail and Location |
| GET `/{rid}`                   | RFQ, invitations, immutable quotes and optional pending order                                     |
| POST `/{rid}/dealer-responses` | `{expected_version,dealer_id,response:QUOTE                                                       | DECLINE}`; 200 detail |
| POST `/{rid}/withdraw`         | `{expected_version,quote_id}`; 200 detail                                                         |
| POST `/{rid}/accept`           | `{expected_version,quote_id}`; 201 detail including exactly one pending order                     |

POSTs require Idempotency-Key, trader role and current trade binding. Reads allow the existing read scope/viewer role. Unknown/repeated query parameters, unknown body fields, invalid IDs/dates/quantities/invitations and unsolicited dealer prices reject. Statuses preserve the foundation envelope: 400/413/415 validation, 401 session, 403 role/binding, 404 foreign/missing/revoked ownership, 409 version/state/expiry/key conflict, 429 quota/admission and 503 persistence/schema/uncertain commit. Independently authored OpenAPI and runtime Zod validate actual JSON.

## Workstation and browser boundary

When the feature is enabled locally, an additive RFQ panel appears below analytics. It can copy analytics' instrument/date/par inputs, explicitly invite dealers, drive deterministic quote/decline/withdrawal, accept a selected firm price and inspect PENDING_ACK. Existing four-tab navigation and equity books remain unchanged.

The panel accepts only a **non-secret sandbox UUID** and works on an **already authorized session binding**. It provides no browser capability creation, recovery or rotation. There is intentionally no end-user browser bootstrap bridge in this phase; native/POSIX ownership tooling or an authorized API client must establish the session binding outside the browser. The existing fake login and token model is preserved, not redesigned.

Before a mutation, the browser retains its original key/path/validated synthetic request in sessionStorage. No capability or bearer token is stored in this command journal. A storage write failure prevents submission. Network loss, ambiguous COMMIT and malformed success retain the command; Retry sends that exact request/key. A confirmed success or definitive state rejection resolves it. It never automatically converts a stale acceptance into a new-key acceptance. Reload/replay is tested. SessionStorage is scoped to the tab; it is not a power-loss or closed-tab durability promise. Durable server history remains available through authorized recovery.

Native browser-test setup creates and binds sessions outside the browser; capabilities never enter page storage, URLs or browser JS. All new workflow-browser projects disable traces, screenshots and video, use no sensitive artifact uploads and do not log headers/storage. Original regression projects/assertions are preserved. Delayed responses are scoped to the current token/reset epoch so they cannot populate a replacement session.

## Quotas, verification and operations

Existing seven-day write/thirty-day recovery retention, 50 retained sandboxes, 512 commands and 1,024 events remain. Each sandbox permits at most 50 RFQs, each with at most three invitations/quotes. RFQ mutations conservatively reserve three remaining event slots before starting, so no multi-event command can partially exhaust audit capacity. The original pool/admission/time bounds remain; 20 SQL-connection race tests demonstrate economic uniqueness, not an HTTP throughput guarantee.

`verification/sql/foundation.sql` independently reconstructs ownership generations and ledger counters while checking contiguous event indices. `verification/sql/rfq.sql` independently verifies accepted-RFQ/order cardinality, selected quote, exact side/price/quantity/date/source/terms, six literal dealer-price cases and three-event acceptance audit. A deliberately corrupted order projection must disagree with SQL. The reconciler role runs read-only; expected values do not come from application RPCs.

```sh
npm ci
npx playwright install --with-deps chromium firefox webkit
npm run validate
npm test -- --repeat-each=2
npm run test:postgres
npm run test:postgres
npm run build:ui
npm run test:workflow-browser
npm run test:workflow-browser -- --repeat-each=2
```

Each PostgreSQL/browser invocation owns a fresh digest-pinned local instance and destroys only its own resources; missing PostgreSQL/browsers fail instead of skipping. The persistence CI workflow executes both database runs, three-browser workflow and repeat, and legacy repeat as unconditional blocking gates. No new hosted service or subscription is introduced. Local compute and existing CI runner allowance are consumed; no billing-zero guarantee is made.

The owned bootstrap can install through migration 002 solely for the populated Phase 2A upgrade rehearsal, then apply 003. Normal bootstrap always applies all migrations explicitly. Runtime never migrates on startup. Exact checksums reject an older/newer incompatible enabled writer: after 003, an unmodified enabled Phase 2A binary fails closed. Operational rollback is feature OFF plus a compatible reviewed artifact while retaining the database. Do not delete accepted contracts or reverse migrations to make an older writer run. Public production remains untouched.

No throughput, high availability, production restore, regulatory audit retention, physical power-loss, live trading or dealer interoperability certification is claimed. Phase 2C requires separate approval for acknowledgments and executions; it has not begun.
