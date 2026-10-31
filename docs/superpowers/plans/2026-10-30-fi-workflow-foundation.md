# Phase 2A persistence and ownership implementation plan

> **For agentic workers:** Use superpowers:executing-plans, with test-driven development and one independent whole-branch review. Only Phase 2A is authorized.

**Goal:** Persist isolated synthetic bond sandboxes with safe recovery, rotation, idempotency, audit and maintenance, without implementing trading workflows.

**Architecture:** Existing native Node HTTP application; optional PostgreSQL adapter; database-enforced ownership/mutation routines; ephemeral session bindings. The feature defaults off and is local-only. Existing equity sessions and Phase 1 financial calculations remain unchanged.

**Tech stack:** Node 24, TypeScript, PostgreSQL 17, pg, Zod, independently authored OpenAPI, real PostgreSQL tests and existing Playwright/Python gates.

**Spec:** User-approved Phase 2 architecture and October 30 Phase 2A implementation approval in this conversation; implemented operational contract will be documented in `docs/FIXED_INCOME_PERSISTENCE.md`.

## Global constraints

- Branch `feature/fi-workflow-foundation` starts exactly at `6016fb700840d081fe1fba651c918f0a7e709383`; PR base is the Phase 1 feature branch.
- No RFQ, quotation, order execution, position, FIX or settlement implementation.
- No merges, deployments, hosted database provisioning, paid services, production changes or other-repository edits.
- Default-off needs no PostgreSQL and preserves existing authentication, financial conventions, tests and deployment behavior.
- Never put credentials, capabilities or tokens in tracked files, ordinary logs, browser traces or CI artifacts.
- Local/CI schema changes require an explicitly owned database; migrations never run on application startup.

## Review focus

- Lost creation/rotation responses: durable client journal must exist before submission; original ownership remains recoverable.
- A stale binding or revoked generation must never authorize after recovery-key rotation.
- Database privileges, pooled RLS context and append-only audit must hold on real connections.
- Capacity, retention and command quotas must remain correct under concurrent operations and cleanup.
- Commit uncertainty, rollback, restart and database outage must never create fabricated success or affect legacy endpoints.

## Task 1: database foundation

Files: `db/bootstrap/roles.sql`, `db/migrations/001_foundation.sql`, `scripts/workflow-database.ts`, local/CI harness and `tests/postgres/foundation.test.ts`.

- [ ] Establish an owned PostgreSQL 17 process/container with nonlogged ephemeral credentials.
- [ ] Write and observe failing schema/privilege tests.
- [ ] Implement checksummed additive migration, dedicated roles, RLS, immutable commands/audit and reference data.
- [ ] Verify migration repetition, mismatch, role privileges and capacity cleanup with real PostgreSQL; commit.

## Task 2: ownership transactions

Files: workflow schemas, PostgreSQL service/access modules, `tests/postgres/ownership.test.ts`.

- [ ] Write failing create/recover/rotate, lost-response replay and concurrent-command tests.
- [ ] Implement atomic routines, request fingerprints, durable receipts, immutable audit and retention/quotas.
- [ ] Verify real connection isolation, generation revocation, same-key conflict and all-or-none failures; commit.

## Task 3: bounded application integration

Files: workflow configuration/routes/bindings, existing server injection points, OpenAPI, new unit/API tests.

- [ ] Write failing configuration, authorization, binding/admission and default-off regressions.
- [ ] Implement local-only optional workflow adapter and safe errors, leaving equity SessionStore unchanged.
- [ ] Verify session/revocation races, schema/outage behavior and existing contracts; commit.

## Task 4: retained client operations

Files: `scripts/sandbox-client.ts`, journal helper and PostgreSQL/CLI tests.

- [ ] Write failing prepare-before-submit, private permissions, lost-response creation/rotation and immutable-journal tests.
- [ ] Implement loopback-only POSIX client with fsynced exclusive private journal creation before sending.
- [ ] Verify restart recovery using retained original operations; no browser recovery UI in this foundation milestone; commit.

## Task 5: reproducible verification and documentation

- [ ] Add required isolated PostgreSQL CI job, local ownership guards and maintenance commands.
- [ ] Document exact schema, API, role/retention boundaries and safe replay/rollback.
- [ ] Run typecheck, lint, full/production audits, formatting, contract/workflow validation, units, Python, clean runtime smoke, real PostgreSQL suite twice, all existing Playwright engines and repeat suite.
- [ ] Record actual failures and results; do not skip missing required dependencies.

## Task 6: independent review and delivery

- [ ] Obtain fresh independent whole-branch review; resolve material findings with failing regressions first.
- [ ] Verify final source, publish feature branch and stacked unmerged PR, inspect actual hosted CI results.
- [ ] Report exact SHA, changed files, results, recovery/isolation evidence, limitations and Phase 2B recommendation; stop.

## Interface preflight

Database routines own persistent transitions; application uses one checked-out client and can roll back before COMMIT after session recheck. Binding registry owns only volatile capabilities/digests and never changes SessionStore semantics. Client journal owns pre-submission material; receipts never contain raw capabilities. New PostgreSQL gates use disposable owned databases and separate role connections.
