# Local FIX Financial Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan directly, task by task. Existing owner execution authorization is preserved. One final fresh-context whole-branch review; no implementer agents.

**Goal:** Apply accepted local FIX application evidence through the existing SQL financial authority, with immutable observations, actual engine callbacks and original-key recovery.

**Architecture:** Separate live decoder and schema9 SDK; registered runtime/store/connection identities precede observation and callback acceptance. A bounded stdio controller drives the private two-engine container and only calls SQL application after durable eligible evidence.

**Tech Stack:** Existing Node24/TypeScript/Python/PostgreSQL17 and the unchanged pinned Go/Java engines. No dependency or economic convention changes.

**Spec:** docs/superpowers/specs/2026-11-07-fix-live-ingress-design.md

## Global Constraints

- Synthetic/local only; no merge, deployment, hosted data, real venue, Phase4 or public HTTP route.
- Preserve SQL001-008, financial kernel/fingerprints, old decoder/dictionary/goldens and434 frozen files.
- Engine container networknone/no ports/no binds/read-only/capdrop/no-new-privileges;1CPU/1GiB/128PIDs/64MiBshm/64MiBstate.
- Wire8192 bytes,64 fields,256 bytes/value; bridge24KiB/envelope,queue16,one in-flight application/direction,ACK5seconds,owned aggregate64MiB.
- Existing SQL pool4/pending12/connection500ms/query2000ms/statement1500ms/lock750ms/idle2000ms/transaction5000ms and retry/unknown-COMMIT policy unchanged.
- Retain512/1024 financial capacity,4bindings,25/43 reservations,15s leases,security headroom and all protocol quotas. No invented economic mapping or raw rewriting.

## Review Focus

1. An observed frame or spoofed callback cannot become financial eligibility; old entry points cannot bypass live binding admission.
2. Same key with changed raw, connection, callback or profile cannot replay success; unknown commit retains the original intent.
3. Database wait/backpressure cannot block engine callback/timer/shutdown; later frames cannot overtake a held frame.
4. Reconnect/rotation/new process does not reset store identity, make a new economic identity or authorize an old fence.
5. New profile/schema reports must not label legacy data live or mark raw-only metadata financially applied.

### Task 1: Separate live raw-byte decoder and literal corpus

Files: create app/protocol/fix44-live/index.ts, tests/unit/fix-live/decoder.test.ts, test-data/fix44/live/*.json, verification/python/fix_live.py, scripts/verify-fix-live.ts; append new unit/oracle gate to package.json; add docs/FIX44_LIVE.md.
Interfaces: `decodeLiveFix44(input:Uint8Array):LiveFixFrame`, `liveFix44Bytes(frame:LiveFixFrame):Buffer`; frame profile literal, direction/type, exact fields and SHA256; private raw-byte provenance distinct from legacy trusted registry.

- [x] Write failing literal tests for fresh/replay ordered headers, D21=1, ATLAS direction, precision/calendar, exact decimals, lengths/checksum/unknown/duplicate fields, invalid business references, copy/provenance and unchanged legacy rejection.
- [x] Run `node --import tsx --test tests/unit/fix-live/decoder.test.ts`; Expected RED missing new decoder.
- [x] Implement only the new decoder, no encoder/byte normalization; run targeted tests GREEN.
- [x] Add independent Python parser/corpus and real engine capture negatives. Run `npm run test:fix-live`; Expected exact literal outcomes, no financial claim.
- [x] Typecheck/lint/format and whole unit suite pass; commit this independently testable boundary with evidence.

### Task 2: Owned schema9 observations and atomic eligibility

Files: add db/live-migrations/009_fix_live_ingress.sql, app/persistence/postgres/live-workflow.ts, app/domain/workflow/live-database-contract.ts, app/server/fix/live-application.ts; tests/fix-live/sql.test.ts and fixtures.
Interfaces: `LiveWorkflowDatabase` satisfies existing WorkflowDatabase SDK type with exact9 checksums; new `LiveFixApplicationService` default OFF, authorized command/read/apply. Live commands register session/connection, bind profile, observe original raw, accept validated callback, then CLAIM/QUEUE/PREPARE/APPLY through SQL. Fixed safe errors and original-key receipts remain bounded.

- [x] Reproduce missing schema/ingress with real owned PostgreSQL tests; Expected RED absent009/profile functions.
- [x] Implement additive RLS/immutable/composite-key state; live fields parsed independently in SQL, body terms use existing economics. Core admission includes profile/context in fingerprint and live session slots.
- [x] Prove raw-only, caller booleans, wrong/cross-sandbox proof, viewer, expired fence/generation and old API calls cannot prepare/apply; forged raw/ID/body conflicts roll back.
- [x] Prove actual acknowledgment/fills/cancel/reject through unchanged kernel, effect-backed capacity and zero duplicate money/capacity on replay; original-key unknown-COMMIT recovery.
- [x] Verify schema8 frozen tests remain valid, schema9 defaults explicit, source preservation and targeted tests pass; commit.

### Task 3: Bounded real-engine bridge

Files: add tools/fix-session/runtime/live_bridge.py, app/server/fix/live-controller.ts, new selected-mode settings/allowlists in engine wrappers and runtime helpers, tests/fix-live/*.
Interfaces: outer JSONL version1 profile, <=24576 bytes/queue16; session/store/connection/attempt IDs are distinct; raw observation and callback acknowledgment are separate; original child SEND limit remains12000 bytes.

- [x] Write controls RED for absent bridge, full queue/pipes, no SQL in engine callbacks, wrong connection/field correspondence and FIFO holds.
- [x] Implement raw capture before forwarding, actual FromApp event correlation and five-second ACK admission. Keep admin handling and response-guard expiry independent of financial progress.
- [x] Exercise real D/8/F/9 financial-valid fixtures, reconnect/store continuity and physical retransmission with no synthetic callback or normalized frame.
- [x] Targeted controls and complete89-control standalone runtime pass; commit.

### Task 4: Independent live evidence and crash recovery

Files: add verification/sql/fix_live_application_v1.sql, verification/python/fix_live_application.py, app/server/fix/live-reconciliation.ts, scripts/test-fix-live.ts and owned live-runtime fixtures.
Interfaces: new schema9/live-v1 snapshot/watermarks bind observation/callback/store and actual financial commands; external delivery/completeness alwaysfalse.

- [x] Literal independent verifier tests RED for missing implementation; isolated corruption must produce named findings.
- [x] Actual process kills before/after observation, callback acknowledgment and financial COMMIT; unrecoverable callback evidence blocks the lane. No reset/new key/retry-after-unknown-COMMIT.
- [x] Full authorized lifecycle BUY/SELL/conventions, original-key replay, rotation, quotas, authority and atomicity pass with independent per-fill rational results.
- [x] Commit complete new gate with all outcomes/uncertainty retained.

### Task 5: Qualification and reviewable delivery

- Run typecheck/lint/full validate, repeated browsers, two full PostgreSQL runs, workstation baseline/repeat, public-demo, complete standalone runtime and new live gate. Preserve first failures.
- Update protocol docs/new JSON contract and CI; no old assertions or deadlines weakened. Run one fresh whole-branch review, regrade all findings/declined areas and do one RED/GREEN material fix pass; ledger minors.
- Push personal feature branch and draft stacked PR based on qualified runtime branch; all exact-head CI jobs must pass before readiness. Human acceptance separate.
- Replace the existing status report with exact evidence and remaining scope; preserve worktree for review. No main merge/deployment.
