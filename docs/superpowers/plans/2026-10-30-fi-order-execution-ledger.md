# Phase 2C Order Lifecycle and Execution Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend exact Phase 2B with immutable executions, controlled order lifecycle/cancellations and execution-derived positions.

**Architecture:** Keep fi.orders and its immutability trigger unchanged. Add order_states, immutable order_history, immutable execution ledger, immutable cancellation requests/outcomes and position projections through additive migration 004. All commands use the existing sandbox lock, transaction-local proof, precommit session verification and completed receipts.

**Tech Stack:** Existing Node 24, PostgreSQL, TypeScript/Zod, Python Fraction/Decimal, Playwright. No dependency or hosted infrastructure additions.

**Spec:** The user's revised Phase 2C approval in this conversation, supplemented by docs/FIXED_INCOME_EXECUTIONS.md (implementation contract). This approval already selects execution and immutable economic contracts; no new approval gate is introduced.

## Global Constraints

Feature defaults OFF. Local and ephemeral CI PostgreSQL only. No changes to migrations 001–003, main, production, other repositories or existing assertions. No merge, deployment, FIX, settlement, clearing or Phase 2D. Exact original twelve-place clean prices, instrument terms, source and settlement. No JavaScript floating-point financial arithmetic. At most eight fills/order. All durable writes require sandbox-scoped idempotency keys. Browser operates on existing authorized binding; no recovery capabilities in browser storage/artifacts.

## Review Focus

- A repeated event under a new command key must not consume quantity twice even after version advances.
- A full fill with pending cancellation must remain FILLED and resolve cancellation as too late.
- Eight partial fills must not strand executable quantity: the eighth fill must complete remaining par.
- Unknown outcomes must retain the original non-secret request/key across UI reload and session changes.
- SQL reconciliation must detect matching corrupt projections and ledger cash inconsistencies independently.

### Task 1: Schema, exact cash and lifecycle command

Files: db/migrations/004_execution.sql; app/domain/workflow/database-contract.ts; scripts/workflow-database.ts; tests/postgres/execution-fixture.ts, execution.test.ts, migration-execution.test.ts.
Interfaces: fi_control.order_command(uuid,text,bigint,text,jsonb,text,text,uuid) returns existing WorkflowResult. fi_control.read_orders(uuid,text,text,bigint,uuid) and read_positions provide owned reads. fi.orders remains immutable PENDING_ACK contract. New state projection starts version 1. Commands ACK_ORDER, REJECT_ORDER, EXECUTE_ORDER, REQUEST_CANCEL, ACK_CANCEL, REJECT_CANCEL.

- [ ] Write/run actual PostgreSQL RED tests for missing RPC/schema, all state transitions, exact per-fill HALF_EVEN and source identity.
- [ ] Add migration with immutable tables, forced RLS, composite keys, narrow definer RPCs, deferred quantity/cash/position integrity, initialization/backfill, retention cleanup and bounded reservation.
- [ ] Test 20 concurrent fills, duplicate/conflicting IDs/keys, deterministic fill/cancel lock ordering and eighth-fill completion; upgrade populated 003 without changing prior receipts/contracts.
- [ ] Run real PostgreSQL gate and record actual outcomes before commit.

### Task 2: HTTP and strict independent contracts

Files: app/domain/workflow/execution.ts; app/server/fixed-income-workflow/order-service.ts, order-routes.ts, routes.ts; contracts/openapi.yaml; tests/postgres/execution-api.test.ts; tests/unit/execution-contracts.test.ts.
Interfaces: /sandboxes/{sid}/orders[/id], /orders/{id}/acknowledgment, /rejection, /executions, /cancellation-requests, /cancellations/{cid}/acknowledgment|rejection; /positions. Command response compact {order_id,lifecycle,execution?,cancellation?}; read detail includes immutable contract/history/ledger/requests. RFQ read remains backward compatible.

- [ ] Run RED API/schema tests; implement normalized requests, strict Zod/output checks and independently authored OpenAPI.
- [ ] Verify 400/401/403/404/409/429/503 and queued logout/rotation, no-capability browser boundary, exact replay responses.
- [ ] Run targeted API/contract/type gates and commit.

### Task 3: Independent financial and SQL oracles, faults

Files: verification/python/execution_reference.py, test_execution_reference.py; verification/sql/executions.sql; tests/postgres/execution-oracle.test.ts, execution-crash.test.ts, execution-crash-worker.ts, zz-execution-restart.test.ts.
Interfaces: Python receives actual committed execution JSON over stdin; no TypeScript imports. SQL reconstructs from immutable ledger plus order contracts, never application summaries.

- [ ] Run independent RED financial/SQL corruption cases then add literal expectations and rational reference calculation.
- [ ] Test ACT/ACT versus 30/360, leap/coupon dates, exact ties and separately rounded partial totals differing from one whole fill.
- [ ] Inject rollback between financial effects, kill process before/after COMMIT, terminate connection around COMMIT, stop/restart owned PostgreSQL; recover original keys only.
- [ ] Verify roles/RLS, audit contiguous event indices/pagination, quotas and maintenance cleanup; run all real database tests and commit.

### Task 4: Authorized workstation lifecycle

Files: app/public/order.ts, rfq.ts, index.html; app/domain/workflow/rfq-journal.ts; tests/workflow-browser/executions.spec.ts; tests/unit/rfq-journal.test.ts.
Interfaces: shared sandbox-scoped non-secret command journal supports exact lifecycle requests; a pending command blocks both RFQ/order mutations for that sandbox. No new ownership bootstrap.

- [ ] Run RED browser/journal cases before implementation.
- [ ] Add order lifecycle, cancellation controls, execution ledger and signed position/cash display with exact strings and validated responses.
- [ ] Run Chromium, Firefox and WebKit normal/repeat suites with zero retries and captures disabled; preserve old tests.
- [ ] Commit verified workstation changes.

### Task 5: Whole-branch verification, review, publication

Files: documentation, CI only if necessary to keep all mandatory checks bounded in existing job budgets.

- [ ] Run npm run typecheck, lint, validate, legacy repeat, full PostgreSQL twice, workflow browsers/repeat, financial and migration checks on final revision.
- [ ] Fresh independent whole-branch reviewer; reproduce material findings RED, fix and run all affected/full gates.
- [ ] Commit and push isolated feature branch; open stacked unmerged PR based on feature/fi-dealer-rfq-acceptance.
- [ ] Inspect all GitHub jobs on exact final source; publish SHA/tree, changed files/checksums, failure history, evidence and limits. Stop at Phase 2C.
