# Phase 2B dealer RFQ and atomic acceptance implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline, TDD, then one fresh independent whole-branch review. The user has explicitly approved implementation of Phase 2B.

**Goal:** Persist sandbox-owned synthetic dealer RFQs through exactly one PENDING_ACK order.

**Architecture:** Extend the default-off local PostgreSQL module with additive migration 003. Database operations own validation, locks, DB-time expiry, immutable quotation/order snapshots, completed receipts and multi-event audit. Existing equity and financial calculations remain independent.

**Tech Stack:** Node 24, TypeScript, PostgreSQL 17, pg, Zod, Playwright and independent Python Decimal/SQL verification. No new runtime dependency.

**Spec:** User's approved Phase 2 architecture, Phase 2B implementation approval in this conversation, and `docs/FIXED_INCOME_RFQ.md` operational contract.

## Global constraints

- Exact starting commit c57471079774b32c82150b9a133b2a6911b8c138; initial PR base feature/fi-workflow-foundation.
- Feature OFF requires no PostgreSQL. Local and ephemeral CI only. Preserve original regressions, sessions, financial conventions, production boundaries and earlier PRs.
- Stop at PENDING_ACK. No acknowledgments, fills, positions, FIX, settlement, real data, external AI, merging, deployment, provisioning or other-repository changes.
- Browser uses an already authorized binding only; no browser capability journal, creation/recovery/rotation interface, secret URLs, logs or trace artifacts.

## Design decisions within the approved scope

- Three fictional dealers ATLAS, BIRCH, CEDAR. RFQ invitations are explicit unique subsets. A trader drives clearly labeled deterministic simulated responses; these are not dealer credentials.
- RFQs OPEN -> ACCEPTED or EXPIRED. Invitations INVITED -> QUOTED or DECLINED; QUOTED -> WITHDRAWN. No response replacement/requote. Quote snapshots are immutable; effective expiry/acceptance status derives from RFQ and invitation.
- RFQ life 300 seconds; firm quote life 30 seconds, bounded by RFQ expiry, both measured in PostgreSQL. Client settlement is explicit and unadjusted in the Phase 1 supported range. Quantity is USD par, 1 through 1,000,000,000 with at most two decimal places.
- Deterministic synthetic-dealer-grid-v1 prices are contractual 12-place strings, with distinct Treasury/corporate bases and dealer offsets. They are invented prices, not yield-model predictions. Phase 1 remains the independent financial analytics model.
- Lock sandbox, then RFQ, then invitation; evaluate clock_timestamp after locks. Per-sandbox serialization also orders rotation and existing quota/receipt machinery. Acceptance emits QUOTE_ACCEPTED, RFQ_ACCEPTED and ORDER_CREATED in one command.
- Audit cursors advance by the unique (command_seq,event_index) pair, with a fixed upper committed command watermark. Existing Phase 2A events retain index zero.
- At most 50 RFQs per sandbox; existing 512-command/1024-event quotas apply with complete event-space reservation before mutation.
- The workstation can enter a non-secret sandbox UUID and operate an existing session binding. Provisioning that binding stays outside browser UI. New browser verification disables all traces/video/screenshots and uses an in-process native setup so no capabilities enter the browser.

## Review focus

- Competing and repeated accepts across connection loss/restart must leave exactly one contractual order.
- Expiry while waiting for locks must reject acceptance using post-lock database time.
- Uninvited/foreign IDs, rotated/expired bindings and read-only scopes must reveal no owned records or authorize mutation.
- Exact ask/bid strings and frozen source/date/quantity/model must survive accepted replay and SQL reconciliation.
- A page boundary inside a multi-event command must neither skip nor repeat events, including when another command commits between pages.

## Task 1: persistence and domain contracts

- [ ] Add failing real PostgreSQL tests for schema, three dealers, RLS/grants, concurrent acceptance, exact snapshots, rejection and independent SQL.
- [ ] Run and inspect RED; implement additive 003, frozen quotes/orders, validated RPC, receipt/audit and cleanup extensions.
- [ ] Update exact schema compatibility checksum and independent foundation SQL for multi-event commands without weakening ownership-generation checks.
- [ ] Run actual PostgreSQL suite; expect all tests pass, zero retained capacity. Commit.

## Task 2: API and recovery

- [ ] Add failing HTTP/OpenAPI tests for RFQ CRUD transitions, all authorization and idempotency boundaries, lost accept response and restart/outage.
- [ ] Implement narrow RFQ routes/service and strict independent OpenAPI; correct audit cursor pair.
- [ ] Add literal independent Python quote/order reference verification of actual HTTP snapshots and BUY/SELL sides.
- [ ] Run units, contracts, Python and real PostgreSQL; expect all pass. Commit.

## Task 3: workstation and cross-browser gate

- [ ] Add failing browser scenarios on a real owned PostgreSQL/app binding; disable sensitive evidence capture from inception.
- [ ] Implement bounded RFQ/quote workstation, exact prices, decline/withdraw, accept and PENDING_ACK output, safe original-key retry, stale response/session protection.
- [ ] Add isolated workflow-browser runner/CI and run Chromium, Firefox and WebKit; expect all cases pass without retries. Commit.

## Task 4: final verification, review and delivery

- [ ] Document contracts, conventions, migration/rollback constraints, replay, secrets and limits.
- [ ] Run complete existing validate/repeat and PostgreSQL twice, workflow browsers/repeat, dependency and production artifact gates. Record failures honestly.
- [ ] Fresh independent whole-branch review; reproduce and resolve material findings, then rerun affected/full gates.
- [ ] Commit/push isolated branch, open stacked unmerged PR, inspect actual CI at final SHA; deliver report and stop.

## Interface preflight

`fi_control.rfq_command(uuid,text,bigint,text,jsonb,text,text,uuid)` consumes sandbox proof, binding generation, action, validated normalized payload, fingerprint/key and actor. It returns the existing WorkflowResult envelope. `RfqService` uses the same WorkflowDatabase transaction and session precommit verifier; read operations call existing ownership authorization. No runtime table-write privilege is added. Quotation snapshot/order generation and final state invariants are DB owned. Workstation only consumes the strict RFQ response schema.
