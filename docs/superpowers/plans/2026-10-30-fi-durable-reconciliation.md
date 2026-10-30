# Phase 2D Durable Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Durable sandbox-owned independent reconciliation and read-only investigation, never financial repair.
**Architecture:** Add migration005 run/finding/event records. Application role requests/reads runs; server-only reconciler uses a bounded repeatable-read READ ONLY snapshot, then a separate narrowly authorized result transaction. Completed runs/findings are immutable. Existing financial SQL guard queries remain independent and are reused alongside detailed expected/observed SQL.
**Tech Stack:** Existing Node24, PostgreSQL17, Zod/OpenAPI, Python standard-library oracle, Playwright. No runtime dependencies or infrastructure additions.
**Spec:** User's attached Phase2D approval, uploaded 2026-10-30; implementation contract in docs/FIXED_INCOME_RECONCILIATION.md.

## Global Constraints

Exact base0efa3fdf265d374af2756c98d24936b157849464/treef43762d715bfe3bee647b486d5cba1a4a194f6cc. DefaultOFF. Preserve001–004, earlier phase branches/PRs, old tests/security and production. No merge/deploy/hostedDB/paidservice/FIX/settlement/bust/correction/curve/other-repository change. No credentials in browser/storage/logs/artifacts.

## Review Focus

- A failed/partial read cannot create a clean run; all declared SQL coverage must finish.
- A claimed scan cannot resume on a different snapshot after crash; stale recovery is INCOMPLETE.
- Fills after snapshot watermark remain outside historical evidence and never get retrospectively attributed to that run.
- Application role cannot submit arbitrary report findings or query SQL; only trusted reconciler records bounded results.
- Earlier exception evidence remains visible after a later clean run and cannot be silently overwritten.

### Task 1: Durable records and permissions

Files: db/migrations/005_reconciliation.sql; database-contract.ts; workflow-database.ts; tests/postgres/reconciliation-fixture.ts, reconciliation.test.ts, migration-reconciliation.test.ts.
Interfaces: reconciliation_command (CREATE_RECONCILIATION, RECOVER_RECONCILIATION), claim_reconciliation, finish_reconciliation, read_reconciliations. Run states REQUESTED→RUNNING→COMPLETED_CLEAN|COMPLETED_WITH_FINDINGS|INCOMPLETE|FAILED. One active run/sandbox,20retainedruns,128findings,15-second lease. Request receipt references immutable run ID; completion/events stored separately without appending late events to earlier financial command sequences.

- [ ] Actual PG RED tests, then additive schema/RLS/narrow RPCs, immutable terminal results, controlled transitions, quota/retention/cleanup, source provenance and paging.
- [ ] Verify actual role restrictions, original-key replay/conflicts, lease recovery and populated004upgrade; commit.

### Task 2: Independent snapshot and reporting engine

Files: app/server/reconciliation/{manifest,scanner,service}.ts; verification/sql/reconciliation.sql; scripts/reconcile.ts; tests/postgres/reconciliation-oracle.test.ts,reconciliation-snapshot.test.ts.
Interfaces: scanSnapshot uses one repeatable-read read-only transaction and scoped fixed SQL; declared hashes/source/schema/model metadata and ledger watermark. Reconciliation uses separate immutable metadata receipts plus a shared sandbox/key registry; it never mutates financial counters to investigate them. All3existing SQL checks plus detailed independent comparisons execute; legacy violations remain findings even if no richer match. Overflow128 or partial coverage→INCOMPLETE, exceptions/timeouts→FAILED. All results historical/as-of.

- [ ] RED corruption and snapshot tests; implement independently calculated expected/observed findings and immutable references, no application finance imports.
- [ ] Test ten defect classes, match-corrupted cash, concurrency during snapshot, limits, independent CLI and no false-clean partial scan; commit.

### Task 3: REST, configuration, recovery and contracts

Files: app/domain/workflow/reconciliation.ts; server workflow integration/routes; configuration/build/local-tool support; contracts/openapi.yaml; tests/postgres/reconciliation-api.test.ts,reconciliation-crash.test.ts,zz-reconciliation-restart.test.ts; unit tests.
Interfaces: optional server-only TRADEFLOW_FIXED_INCOME_RECONCILER_URL must use tf_reconciler on exact same owned DB as app. Existing enabled workflows remain valid without it. POST /reconciliation-runs {run_id}, POST /{rid}/recover {}, GET list/detail/findings with bounded keyset pagination. Read roles may inspect; only trader/trade binding requests/recovery. Every POST journals original key/request before submission.

- [ ] RED strict contracts/config/API tests; preserve error envelopes/current proof/session checks and no unrestricted SQL/report endpoint.
- [ ] Actual lost-response, restart, pre/post-COMMIT crash, partial-record rollback, logout/rotation, concurrent identical/different keys, lease/recovery and cleanup tests; commit.

### Task 4: Read-only workstation investigation

Files: app/public/reconciliation.ts,rfq.ts,index.html; shared non-secret command journal; tests/workflow-browser/reconciliation.spec.ts.
Interfaces: existing authorized sandbox; initiate run and inspect immutable results, watermark/coverage/categories/record IDs/expected-observed, failed/incomplete/historical versus latest-completed. No repair controls or browser capability handling.

- [ ] RED browser/journal tests; implement scoped validated UI, original-key replay and pages.
- [ ] All3engines normal/repeat on actual PG, preserving old assertions; commit.

### Task 5: Final verification and independent review

- [ ] All old/new unit/Python/PG twice/API/OpenAPI/financial/normal+repeat browsers and mandatory hosted gates on exact final source.
- [ ] Fresh independent whole-branch source review; material findings RED→GREEN correction; retain failures and rulings.
- [ ] Commit/push isolated feature/fi-durable-reconciliation; unmerged stackedPR basefeature/fi-order-execution-ledger; full report hashes/files/evidence/limits. StopPhase2D.
