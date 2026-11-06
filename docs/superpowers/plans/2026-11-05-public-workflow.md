# Public Institutional Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare and verify the complete public synthetic workflow without changing the current live application.

**Architecture:** Preserve the existing application and financial/database contracts. Add an explicit optional hosted profile, server-owned visitor workspace bootstrap, a separate short-lived demo database profile, and a least-privilege maintenance worker.

**Tech Stack:** Existing Node 24, TypeScript, PostgreSQL 17, native HTTP, pg, Zod, Playwright and GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-05-public-workflow-design.md`

## Global Constraints

- No production changes, merge, force push, credentials changes, live financial connectivity or deployment.
- Preserve original checkouts, all worktrees, untracked plans and evidence.
- Legacy local/hosted behavior and all financial/FIX contracts remain unchanged.
- Ownership capabilities stay server-side; strict database TLS; no privileged runtime role.
- Proposed public-only writes 30 minutes, retained records 60 minutes; legacy 7/30-day policy unchanged.
- Existing 50-sandbox retained capacity, quotas, deadlines and CI gates remain intact.

## Review Focus

- Same-session concurrent bootstrap and connection failure around COMMIT must preserve one intent/key.
- Logout/expiry during bootstrap or financial mutation cannot authorize a replacement session.
- Incorrect TLS chain/hostname or URL overrides must fail before financial access.
- Maintenance failure or active reconciliation must not delete active records or imply successful cleanup.
- Public browser paths must never require or export native ownership capabilities.

### Task 1: Explicit profile configuration and strict database transport

**Files:** `app/server/configuration.ts`, new `app/server/public-demo/configuration.ts`, database pool constructors, `tests/unit/public-demo-configuration.test.ts`, TLS integration tests.

**Interfaces:** Parse optional hosted profile into typed role-specific pool connection options; existing workflow URLs remain governed by the original local-only guard.

- [ ] Write and observe failing configuration tests for complete valid profile, partial/unknown activation, wrong role/database/host and URL TLS overrides; preserve legacy rejection cases.
- [ ] Implement strict validation and explicit verified TLS pool configuration without changing base transaction behavior.
- [ ] Run targeted and full unit suites; retain exits and logs.

### Task 2: Optional public database profile

**Files:** new `db/public-demo/001_profile.sql`, profile contract/checksum validator, isolated profile installer, `tests/postgres/public-demo-profile.test.ts`.

**Interfaces:** Separate `create_public_demo_sandbox` returns the existing validated sandbox body with public-only literal timestamps. Base migrations remain byte-identical; a branded profile and role checks gate access.

- [ ] Write and observe failing real PostgreSQL tests for public lifetime, legacy lifetime preservation, roles, immutable ledger, exact-key replay/conflict and profile mismatch.
- [ ] Implement additive optional profile creation and checks; preserve maintenance-only expiry purge.
- [ ] Verify expired public records reclaim capacity while active/legacy records remain untouched.

### Task 3: Server-owned visitor workspace and lifecycle

**Files:** new `app/server/public-demo/workspaces.ts`, `app/server/index.ts`, workflow route integration, new HTTP/contract tests and OpenAPI paths.

**Interfaces:** Explicit authenticated workspace start/status uses the existing synthetic session and returns only sandbox metadata/scope. One retained private intent per session; no browser capability input.

- [ ] Write/observe failing tests for two visitors, viewer scope, unauthorized/cross-session reads, concurrent start, uncertain outcome retry, logout/expiry and blocked native ownership routes.
- [ ] Implement bounded workspace state, binding and failure-safe retry without changing financial service contracts.
- [ ] Implement separate bounded maintenance worker; verify outage/error/shutdown behavior with owned resources.
- [ ] Run real HTTP/contract/PostgreSQL suites with independently asserted literal results.

### Task 4: Public workstation and evidence navigation

**Files:** `app/public/rfq.ts`, `app/public/index.html`, focused CSS if needed, public browser tests, evidence references and documentation.

**Interfaces:** Public profile exposes a start action and uses the existing workflow views. Local native ownership UI remains unchanged. Evidence explicitly labels offline FIX.

- [ ] Write/observe failing browser journeys for actual visitor bootstrap through RFQ, exact partial execution/cancellation and clean reconciliation; viewer/expiry/unavailable states.
- [ ] Implement minimal controls and truthful disclosures using existing semantic UI.
- [ ] Verify multiple browser contexts and responsive/keyboard behavior; retain private-state capture restrictions.

### Task 5: Candidate qualification and review

**Files:** affected CI validation, README/current state/setup/release documentation, exact revision evidence.

- [ ] Run dependency audits, types/lint/format, independent financial/FIX verification, normal/repeated API/browser tests, twice-isolated PostgreSQL tests, existing workstation/interview and public profile tests.
- [ ] Obtain one fresh whole-branch review and fix material issues in one bounded test-driven pass.
- [ ] Publish a dedicated PR with actual results, limitations, exact tree/source and proposed hosted configuration; leave unmerged.
- [ ] Rehearse hosted topology only within separately authorized infrastructure scope. Record any unresolved provider/TLS/cost blocker honestly.
- [ ] Request production approval only for the concrete reviewed release. After approval, publish pinned source and verify the real public workflow; preserve rollback evidence.
