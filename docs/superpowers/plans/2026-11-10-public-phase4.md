# Public Phase 4 implementation plan

Owner approved the release/exposure design on 2026-11-10. This plan authorizes repository implementation and local/CI qualification only. Design: `docs/superpowers/specs/2026-11-10-tradeflow-release-exposure-design.md`.

## Goal and boundaries

Expose the accepted finite post-trade model through the existing public synthetic workstation. Keep four tabs, session-owned capabilities, least privilege and all accounting limits. Preserve original migration bytes, financial kernels/oracles, private owned-only admission, original retries/deadlines and existing public-v1 contracts. No provider configuration, resources, public cutover or risk waiver is authorized here. Historical finding remains UNKNOWN / UNRESOLVED_NOT_REPRODUCED; recurrence blocks work.

Architecture: additive public-posttrade-v1 SQL/image/admission class; explicit `TRADEFLOW_PUBLIC_POSTTRADE=on`; existing session-bound routes; server-validated browser views; original-intent recovery. Public-v1 remains the default. Runtime roles never migrate. Native FIX stays local/CI. Original pinned source changes require a separate exact reviewed admission before native qualification; never refresh pins automatically.

## Review focus

1. A viewer, another session, revoked binding or expired login cannot write or replay a financial receipt; reauthorization also precedes COMMIT.
2. An admitted FAILED 409 is recoverable with its original key; an ordinary rejection consumes no financial key. OUTCOME_UNKNOWN preserves the original request.
3. Processing dates never move backward; balances use recorded source sequence. Date, revision and recorded UTC remain distinct.
4. Incompatible profile/schema/source/TLS/roles fail closed; raw accounting tables remain inaccessible. Existing local and public-v1 admission do not broaden.
5. Exact BUY100/SELL40 accounting, reversal conservation, rounding disclosure, expiry with leases, full graph cleanup and stale UI responses are independently observable.

## Tasks

### 1. Explicit configuration and profile contract

Files: `app/server/public-demo/configuration.ts`, `profile.ts`, new `posttrade-profile.ts`; `tests/unit/public-posttrade-configuration.test.ts`.

- [x] RED: assert explicit on selects post-trade; absent/off preserves old result; invalid flag and partial/nonpublic configuration reject without secret disclosure.
- [x] GREEN: optional `postTrade: true`, strict on/off validation; `PublicProfileKind = workflow | posttrade`, separate name/checksum, existing verifier defaults unchanged.
- [x] Verify targeted units, typecheck; commit configuration/contract.

### 2. Separate hosted database admission and wiring

Files: new `app/persistence/postgres/public-post-trade-workflow.ts`; `app/server/index.ts`, `fixed-income-workflow/routes.ts`, `public-demo/{workspaces,maintenance}.ts`; `contracts/openapi.yaml`; relevant unit and HTTP tests.

- [x] RED: wrong/unsafe TLS targets reject; schema10/profile mismatches and role escalation deny; old profile has no post-trade service; status contract explicit.
- [x] GREEN: new subclass reuses bounded LiveWorkflowDatabase transactions, validates exact 001–010/source/profile and least privilege. Explicit configuration selects this class; private class untouched.
- [x] Add `/api/public-demo/posttrade/status` with existing strict WorkflowStatus response. Existing status routes retain exact bodies. Profile kind flows through workspace/maintenance checks.
- [x] Verify targeted units, contracts and real SQL/HTTP tests; commit.

### 3. Fresh public-posttrade database profile and image

Files: new `db/public-posttrade/001_profile.sql`, `deployment/posttrade-postgres/{Dockerfile,init.sh,SHA256SUMS}`, `scripts/validate-public-posttrade-profile.ts`; profile tests.

- [x] RED: actual fresh TLS image rejects source/manifest/profile mismatch and unsafe role access; fresh image refuses foreign identity/authority and incompatible existing profiles.
- [x] GREEN: additive fresh-only profile; exact original 001–010; original distinct roles/TLS entrypoint; explicit metadata name/version/checksum. Fresh-image initialization requires distinct credentials, nonce and complete original migrations; original private installer is unchanged.
- [x] Verify actual image, RLS/grants, all role paths and complete cleanup; commit. Never run migrator against hosting.

### 4. Hosted financial qualification fixture

Files: new `tests/public-posttrade/` HTTP/database/accounting/lifecycle fixtures, new `scripts/test-public-posttrade.py`, package command; new CI workflow.

- [ ] RED: actual-image journey initializes paper funding, registers BUY100/SELL40, corrects consideration100.88/43.80, retains FAILED sell receipt, settles nondecreasing dates, verifies par60/basis60.528/realized3.448/rounded equity100000003.49 with independent reconstruction.
- [ ] GREEN: wire existing financial services only. Test original-key replay, pre-admission no-key, cutoffs, wrong dates/revisions, capacity, viewer/cross-session, missing marks, before/after-COMMIT uncertainty, logout/restart and full expiry cleanup including reservations/leases.
- [ ] Verify old public-image gate and private post-trade gate independently; commit fixture/gate.

### 5. Stateless analytics views

Files: `app/public/{fixed-income.ts,index.html,style.css}`, new `advanced-analytics.ts`; browser tests/page objects.

- [x] RED: zero appears only in analytics; named curve/as-of/spread renders validated results; stale session cannot publish; keyboard and320px views remain usable.
- [x] GREEN: v2 zero schema and v3 curve schema, explicit simulated dates, existing two tradable instruments unchanged. No financial calculations in browser.
- [x] Verify Chromium/Firefox/WebKit targeted tests; commit.

### 6. Post-trade workstation and original-request recovery

Files: new `app/public/post-trade.ts` and bounded intent journal; `rfq.ts`, `index.html`, `style.css`; browser/API tests.

- [ ] RED: trader walks required example, viewer stays uninitialized/read-only, 409 FAILED retains receipt, uncertain original intent recovers without duplicate, stale responses/session reset cannot populate replacement workspace.
- [ ] GREEN: controls for explicit paper funding, registration, correction/bust, settle/reverse; server-derived balances/obligations/risk/FIFO/equity; bounded commands/audit views, declared scales/rounding/provenance. New attempt is explicit; original intent never silently replaced.
- [ ] Verify three browser engines baseline/repeat, mobile/keyboard and independent accounting; commit.

### 7. Documentation and release provenance

Files: README, CURRENT_STATE, PHASE4_POSTTRADE, setup/demo/recovery docs and release receipt; native evidence card in index.html.

- [x] Record approved implementation scope, exact accepted versus deployed source, unresolved historical risk and deployment boundary. Document profile activation/fresh database, dates, viewer/recovery semantics, walkthrough and cleanup.
- [x] Replace stale native claims with revision-bound local/CI evidence links. Reconcile historical PRs individually; no blind merges/closures.
- [x] Verify docs against actual commands/evidence; commit.

### 8. Integrated qualification and source admission

- [x] Run locked install/audits; typecheck/lint/format/contracts/workflow/units/oracles/build/production smoke; `npm run validate`; browser repeat2 at62ab3a7 (1122 units,264/528 cases). Final published CI remains required.
- [ ] Run two fresh original and owned PostgreSQL passes, workstation/public-v1/new-public-image and native gates serially. Preserve first-failure evidence. Stop financial recurrence for investigation.
- [ ] If source preservation blocks, finish ordinary qualification, list exact changed pinned paths/new hashes/diff and seek separate reviewed disposition. Do not edit source pins to pass.
- [ ] Bind all receipts to final commit/tree/CLEAN provenance; no unexecuted checks labelled passed.

### 9. Independent and human acceptance

- [ ] Perform self-review against five focus cases; collect whole-branch diff and actual evidence.
- [ ] Obtain fresh independent whole-branch review; fix Critical/Important issues, rerun affected checks. Record rulings/deferred minors.
- [ ] Present concrete candidate, validation/remaining uncertainty and exact decisions for human acceptance. Keep draft until human acceptance and all required source/protection gates. Existing authorization does not cover provider preview/cutover.

## Progress and changes

Execution ledger: `.superpowers/sdd/2026-11-10-public-phase4/progress.md`. Each task records first RED, implementation, verification, commit, deviations/rulings. Tests assert observable financial/security behavior; no tests that merely restate source text. Add no dependency or numerical convention. Implementation interfaces may be refined when repository evidence requires it; record the reason without expanding scope.

Implementation checkpoint: exact financial/profile/browser boundaries and documentation are implemented. Tasks4–6 have passing targeted development receipts; final actual native-application/browser and integrated CI receipts remain required. Task8 is blocked at native admission until the exact additional18-path proposal is separately accepted. The fresh whole-branch review is complete; its two Important evidence gaps have a single fix pass with actual public SQL/Python reconstruction14/14 passing at62ab3a7. Human acceptance and any merge/preview/deployment remain pending. See `docs/PUBLIC_POSTTRADE_CANDIDATE.md` for source-bound results and first failures.
