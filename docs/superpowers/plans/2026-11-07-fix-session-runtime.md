# Phase 3C1 local FIX session runtime implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Owner approved the linked design and implementation on November 7, 2026. Execute natively; one fresh whole-branch review follows.

**Goal:** Implement the approved local QuickFIX/J session runtime and independent QuickFIX/Go peer, with bounded session, recovery and fault evidence.
**Architecture:** A locked build produces one network-isolated runtime container. Real loopback transport and separate retained stores support a synthetic, transport-only verification matrix. Existing app/SQL/FIX financial code remains byte-preserved.
**Tech Stack:** Node 24 project; Python 3.12+ standard-library orchestration; QuickFIX/J 3.0.2; QuickFIX/Go v0.9.12; pinned Java/Go/container toolchains.
**Spec:** docs/superpowers/specs/2026-11-07-fix-session-runtime-design.md

## Global Constraints

- One runtime container, no external runtime network, no host ports, no host networking; private loopback proxy19875 and acceptor19876 only (recorded implementation ruling).
- Runtime: 1 CPU, 1 GiB memory, 128 PIDs, 64 MiB shm, 64 MiB total owned store/log/evidence budget.
- Fixture framing: 8192-byte frame, 16384-byte input buffer, 64 fields, 256 bytes/value; preserve original application codec limits.
- HeartBtInt 30; both CompIDs TRADEFLOW/ATLAS; automatic resets disabled. Separate original session identity from connection/attempt identity.
- Transport-only D/8/F/9 probes; no SDK imports, financial mutation, database credentials, HTTP routes or public deployment.
- Original migrations001-008, goldens, dictionary, SQL/pins, financial semantics, deadlines/retries and protections remain unchanged.
- Required preflight: obtain and hash exact official standard with November 2020 errata and published test cases before authoring runtime expected results. Challenge pages and older standards cannot satisfy this gate.
- Initial new gate deadlines: dependency/reference fetch 30 seconds/request and 16 MiB/reference; build 900 seconds; ordinary scenario 60 seconds; actual timer scenario 150 seconds; complete new runtime suite 900 seconds. These do not change existing deadlines.
- Stop on unsupported upstream pin, required reference unavailable, or a required engine patch; report exact blocker. No replacement engine/version or standard is implicit.

## Review Focus

1. Store corruption, deleted store or wrong identity must not silently reset a live session.
2. An application probe omitted by a faulty proxy must not be hidden by an administrative gap fill.
3. Peer bytes may violate the old strict header profile: preserve actual bytes and report incompatibility honestly.
4. A killed or timed-out child cannot create an empty successful receipt; retained uncertainty remains explicit.
5. Evidence/log growth and child-process ownership must remain bounded through failures.

## Task 1: Frozen references, dependency preflight and preservation baseline

**Files:** Create tools/fix-session/preflight.py; tests/fix-session/test_preflight.py; tools/fix-session/dependencies.lock.json; verification/vendor/fix-session/REFERENCES.md; approved spec and this plan.
**Interfaces:** validate_reference(status, content_type, payload, expected_sha256, kind) returns validated bytes identity or a fixed PreflightError; checked_download(url,...) validates HTTPS/host/redirect/body/status/bounds and writes only admitted bytes. Lock names exact source/artifact hashes; no untrusted diagnostic bodies.

- [ ] Write failing controls for HTML 200/202, wrong PDF magic, truncated/oversize bytes, hash mismatch, forbidden redirect/origin and missing lock member.
- [ ] Run Python unittest discovery and inspect RED failure due to missing admission behavior.
- [ ] Implement bounded reference admission; run all controls GREEN.
- [ ] Retrieve actual official standard/test case bytes, engine revisions/licenses/JARs/source, image digests and dependency inventories; scan current advisories. Do not mark this step complete if only landing pages are available.
- [ ] Freeze existing tracked application, migration, oracle/dictionary and golden identities; run locked install and unit/FIX baseline in the isolated checkout.
- [ ] Commit only admitted references, preflight controls and planning with exact observed status.
      Expected: complete reference/pin admission and existing baseline green. If reference/pin gate blocks, retain partial preflight as a blocked checkpoint and stop before Tasks 2-5.

## Task 2: Owned runtime and peer without financial wiring

**Files:** tools/fix-session/java/pom.xml and src/main/java/tradeflow/SessionMain.java; verification/fix-peer/go/{go.mod,go.sum,main.go}; tools/fix-session/Dockerfile; tests/fix-session/test_runtime.py.
**Interfaces:** both children accept bounded command lines on owned stdin; emit fixed structured lifecycle/probe events. Config paths and run identity are supplied only by the trusted orchestrator; start/stop/liveness and store paths are explicit.

- [ ] Write failing startup, effective config, non-loopback rejection, second-writer/store identity, zero-discovery and financial-isolation tests.
- [ ] Implement exact synthetic roles and distinct stores; compile from locked dependencies; emit full engine/toolchain version hashes.
- [ ] Run real Logon/Logout and exact-decimal D/8/F/9 transport callbacks; compare against separately authored fixtures.
- [ ] Prove no host ports/external runtime network/database/SDK; inspect actual emitted headers against existing codec without weakening it.
- [ ] Commit runtime/peer and controls only when all Task 2 expectations pass.
      Expected: real local peer handshake and transport-only probes, current-codec compatibility explicitly measured.

## Task 3: Literal session matrix, bounded fault proxy and replay

**Files:** contracts/fix-session-runtime-v1.json; test-data/fix44/runtime/manifest.json and raw fixtures; tools/fix-session/runtime/{driver.py,transport.py}; tests/fix-session/test_transport.py.
**Interfaces:** bounded transport preserves raw bytes and direction; declared per-case fault actions drop/duplicate/disconnect named frames. Each result records peer receipt, session continuity, evidence completeness and financial_application_verified=false separately.

- [ ] Freeze all S01-S15 case IDs and expected literal outcomes against admitted source section/test references before implementation.
- [ ] RED controls cover malformed/oversize/checksum/frame order/unsupported types, message gaps, duplicate conflict and known missing runtime behavior.
- [ ] Implement only the reviewed guards and fault orchestration; never edit engine stores to create a gap.
- [ ] Exercise both TestRequest directions, ordinary heartbeat distinction, administrative gap fill and exact application replay identity/body.
- [ ] Run complete Task 3 matrix, inspect wire/store identities, and commit GREEN.
      Expected: no hidden gap, new logical work from duplicate or repaired wire evidence.

## Task 4: Restart, crash, time and quota evidence

**Files:** tests/fix-session/test_recovery.py; tools/fix-session/runtime/{ownership.py,evidence.py}; populated fixture controls.
**Interfaces:** owned process barriers identify supported persisted-send/receive states. Store inventory and run-descriptor verification precede restart and cleanup.

- [ ] RED controls reproduce wrong identity/corrupt/missing store, second writer, child kill, queue/store bounds and incomplete shutdown.
- [ ] Implement bounded ownership/evidence and restart admission, with safe unresolved outcomes for unsupported crash points.
- [ ] Execute actual process kill/restart cases, live 30-second heartbeat/TestRequest/disconnect case, and deterministic boundary cases.
- [ ] Check one-over limits, denied resets and calendar-boundary sequence continuity; retain first failures.
- [ ] Commit only after all named cases and complete new gate pass.
      Expected: continuity where proved, explicit failure/uncertainty elsewhere; no empty-store fallback or deleted unacknowledged evidence.

## Task 5: Complete integration gates and reviewable PR

**Files:** scripts/test-fix-session.py; package.json; dedicated .github/workflows/fix-session.yml; docs/FIX44_RUNTIME.md; docs/CURRENT_STATE.md; evidence record.
**Interfaces:** npm run test:fix-session returns nonzero for missing tools/pins/cases, child failure, deadline or expectation mismatch. CI job invokes the same full mandatory new gate.

- [ ] RED tests establish failure propagation, reference/pin mutation rejection and immutable old-source boundaries.
- [ ] Implement command/discovery/CI wiring; add no public app dependency.
- [ ] Run typecheck, lint, validate, existing repeat suite, two complete real PostgreSQL runs, workstation baseline/repeat, public-demo and the new session matrix as required by the unchanged current complete gate policy.
- [ ] Verify all original hashes and unrelated worktree/resource inventory; preserve failed attempts and exact candidate identity.
- [ ] Obtain fresh whole-branch review; fix material issues with reproducing controls. Publish a feature PR with actual evidence; do not merge or deploy without final human acceptance.
      Expected: reviewable exact-source PR and truthful bounded claims. No Phase 3C/Phase 4 completion claim.
