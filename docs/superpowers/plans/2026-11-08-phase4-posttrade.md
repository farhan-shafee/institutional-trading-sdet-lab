# TradeFlow Phase4C-F Owned Post-Trade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete owner-approved portfolio risk, immutable adjustments, funded synthetic settlement and exact FIFO valuation/P&L with owned-source/recovery/capacity evidence.

**Architecture:** Pure kernels build on the reviewed Phase4B exact arithmetic and curve engine. Additive010 owns a finite append-only post-trade graph, shared key/ownership admission and aggregate capacity protection. An explicitly injected owned schema10 client exposes local/CI APIs and a source-bound report journey; original schema8/9 behavior remains default and preserved.

**Tech Stack:** TypeScript, decimal.js80, Rational bigint, Zod/OpenAPI, PostgreSQL, existing owned process/network harnesses, independent Python Decimal125/Fraction.

**Spec:** docs/PHASE4_COMPLETION_CONTRACT.md sections4C-F/shared constraints; docs/superpowers/specs/2026-11-08-phase4-posttrade-design.md (executor choices explicitly labeled).

## Global Constraints

- Original001-009 bytes/checksums, raw executions/order/FIX receipts and original assertions remain unchanged.
- Only phase1-ust-1/phase1-corp-1 are post-trade eligible. At most8 registered original execution roots; every raw root through source must be registered/supported for complete assessment.
- Max2 price corrections and1 terminal full bust/root; preserve original par/side/instrument/agreed settlement_date. Settled revisions must reverse first.
- Initialization100000000.00USD/zero securities, equal opposite funding entry; gross all-or-nothing DVP. No deposits/borrow/overdraft/margin/netting/partial settlement/fees/FX/coupon or redemption income.
- Fixed [economic_start_date,first following contractual coupon) window applies to every root including closed/flat, settlement and assessment. Weekday processing>=due; assessment>=all non-busted value dates.
- Proposed executor date-order interpretation and pre-admission receipt rules are disclosed in the design and require final owner review; do not represent them as an earlier explicit owner choice.
- Max2 failed settlements,3 successful postings and3 reversals/root; each revision posts/reverses at most once, reversed settlement terminal.
  -97 commands/161 events reserved including initialization; aggregate legacy+post-trade<=512/1024, preserve B2 25/43 and actual remaining security headroom.
- Existing pool4/pending12,checkout500ms/query2000ms/statement1500ms/lock750ms/idle2000ms/deadline5000ms and3 pre-COMMIT deadlock retries remain unchanged.
- Risk: signed dirty PV, central1bp parallel/four-node DV01, +100/-100/steepener[-50,-25,25,50]bp stresses; risk8dp, dollar marks2dp, aggregate unrounded.
- FIFO_DIRTY_USD_V1: exact execution cash cents, long/short FIFO at original command sequence+stableID, exact rational partial allocations, aggregate-only rounding.
- Read assessments recompute deterministically and bind sandbox/current generation/raw+adjustment sequence/instrument/curve/model identities; no durable assessment writes or client positions.
- No public activation/deployment. Exact future preservation changes remain pending owner acceptance; do not auto-refresh hashes or waive the current guard.

## Review Focus

- A failed or backdated settlement cannot provide future assets to an earlier processing state; disclose current sequence balances separately from economic mark dates (Tasks5/6).
- Partial fills can have par0.01 and valid corrected cash0; preserve exact cash, half-even ties and short/cover allocation without minimum-cent invention (Tasks2/4/5).
- Combined legacy/PT/FIX reservation and rotation/BIND races must never over-admit512/1024, while uninitialized sandboxes retain original behavior (Task3).
- Closed/busted/flat inventory and historical source cutoffs cannot hide an out-of-window/unregistered/ninth raw root; unavailable must never become zero (Task6).
- Reauthorization, global key conflict, expected revision and settled-reversal races must serialize before replay/effect; lost COMMIT must recover original receipts only (Tasks3-7).

---

### Task1: Unrounded signed dollar risk kernel

**Files:** Create app/domain/post-trade/risk.ts; tests/unit/post-trade-risk.test.ts; verification/python/risk.py; tests/unit/post-trade-risk-oracle.test.ts. Modify the new curve mark guard only if verified-zero display needs it.
**Interfaces:**

- RiskVector={pv:Decimal,parallel_dv01:Decimal,key_rate_dv01:readonly Decimal[4],stress_pnl:Record<StressId,Decimal>}.
- instrumentDollarRisk(curve:CurveSnapshot,instrument:CurveInstrumentId,signedPar:Rational):RiskVector.
- aggregateDollarRisk(vectors:readonly RiskVector[]):RiskVector; dollarRiskWire(vector):{pv_usd:string,parallel_dv01_usd:string,key_rate_dv01_usd:readonly string[4],stress_pnl_usd:Record<StressId,string>}.
- Pure math supports all3 curves/instruments; owned post-trade assessment eligibility remains the original2.

- [x] Write failing tests for literal one-year zero PV970445.53354850817693 and DV0197.04455351659174003221 at par1000000; BUY/SELL sign symmetry, zero/offset aggregate, finite-bump KRD nonidentity, named stresses, invalid fractional-cent/oversized signed par and forged curves.
- [x] Run focused tests RED before module implementation.
- [x] Implement central finite bumps/stresses using original unrounded curveMeasure and aggregate-before-format; explicitly canonicalize numeric negative zero.
- [x] Independently implement Python125 risk repricing and compare72 signed fixture/instrument/date cases at max(0.000001USD,1e-8*absolute oracle). Watch the missing oracle RED then all agreement GREEN.
- [x] Run focused/full unit/static checks and commit.

### Task2: Exact FIFO long/short kernel

**Files:** Create app/domain/post-trade/economics.ts,fifo.ts; tests/unit/post-trade-fifo.test.ts,post-trade-fifo-oracle.test.ts; verification/python/fifo.py.
**Interfaces:**

- EconomicExecution={execution_id:string,command_seq:string,instrument_id:original2,definition_version:string,side:BUY|SELL,par_amount:string,consideration_cents:string,value_date:string,revision:number}.
- FifoLot={opening_execution_id,instrument_id,side:LONG|SHORT,remaining_par:Rational,remaining_basis_or_proceeds_usd:Rational}.
- fifo(executions:readonly EconomicExecution[]):{realized_usd:Rational,lots:readonly FifoLot[],positions:readonly {instrument_id,signed_par:Rational}[]}; max8 inputs, unique root IDs, original ordering.
- Corrections/busts are resolved before the kernel; it does not accept order reopening or derive trade dates.

- [x] Write failing literal100.88 BUY100 /43.80 SELL40 case (basis60.528,realized3.448), partial multi-lot closures, sell-short/cover, crossing long-to-short,0.01par/cash0, correction at original ordering and duplicate/unsupported input rejection.
- [x] Run missing module RED.
- [x] Implement exact proportional cash allocations, oldest opposing-lot consumption and immutable results; no intermediate rounding.
- [x] Independent Python Fraction reconstructs deterministic <=8-root sequences; compare exact numerator/denominator realization, lots and signed par. Observe oracle RED->GREEN.
- [x] Run focused/full unit/static checks and commit.

### Task3: Owned schema10, registration, keys and finite reservation

**Files:** Create db/posttrade-migrations/010_post_trade.sql; app/domain/post-trade/database-contract.ts,contracts.ts; app/persistence/postgres/post-trade-workflow.ts; scripts/posttrade-workflow-database.ts; scripts/run-posttrade-tests.ts,test-posttrade.ts; tests/post-trade/fixture.ts,schema-ownership.test.ts,capacity.test.ts.
**Modify:** app/persistence/postgres/live-workflow.ts only protected compatibility extension hook; package.json new test command. Preserve old transactions/timers and explicit schema8/9 compatibility.
**Interfaces:**

- PostTradeWorkflowDatabase extends LiveWorkflowDatabase, overrides protected liveCompatible to exact001-010/source/role. It accepts only owned loopback target.
- migratePostTrade(ownerPath):Promise<void> validates owner marker and exact8/9/10 states under existing migration lock, applies only missing validated009/010, stores exact checksums; unknown/mutated source refuses.
- fi_control.posttrade_command(sid,proof,generation,operation,payload,key,actor) returns existing status/body/replayed wrapper. SQL computes canonical request hash itself. Initial operations INITIALIZE/REGISTER.
- fi_control.read_posttrade(sid,proof,scope,generation,raw_as_of,posttrade_as_of) returns bounded owned snapshot/coverage; explicit uninitialized state.
- Global key domain POSTTRADE extends007 by a checked exact CASE insertion, retaining private FIX_PREPARED transfer. Shared reservation guards include legacy count writers, PT initialization and FIX reservation insertion.
- New complete test command runs original455 schema8 through existing runPostgresVerification, then a fresh owned010 child suite through the same unchanged cancellation/cleanup wrapper.

- [x] Write real SQL failing schema/ownership/default-off/forced-RLS/least-privilege/unknown-checksum tests, current-generation reauthorization and key conflict/replay across old/new families.
- [x] Write exact independent SQL physical count tests for initialization1/1, registration1/1,97/161 allocation incl own receipt, free/reserved boundary refusal and INIT/FIX-BIND/legacy-writer/rotation races; no effect on denial.
- [x] Run RED on missing010/client/RPC.
- [x] Implement bounded tables, immutable receipts, exact raw-root registration and window, current source read, private consistency constraints and full cascade cleanup. Do not change original counter meaning or001-009 files.
- [x] Run real010 suite plus original455, full unit/static checks; verify cleanup/retained zero and unchanged8/9 fail-closed behavior, commit.

### Task4: Append-only correction and terminal bust

**Files:** Extend the unaccepted010 migration and static checksum; add tests/post-trade/adjustments.test.ts; domain/runtime writer schemas.
**Interfaces:** CORRECT_PRICE payload{execution_id,expected_revision,clean_price}; BUST payload{execution_id,expected_revision}. SQL returns immutable original-key receipt/root reference. Register only actual owned raw execution.

- [x] Write failing full/partial-root correction/bust, two-correction bound, terminal bust, changed immutable fields/foreign root denials, stale-revision concurrent winners, raw ledger/order/FIX unchanged, auth-before-replay and retained historical source tests.
- [x] Write literal0.01par valid clean10 correction cash0; exact half-even/accrual; scalar bracket endpoints and out-of-range price tests against an independent oracle.
- [x] Implement exact rational scalar-bracket admission (bounded integer-power comparison) and reuse original execution_cents/accrual conventions; append compensation/replacement2 events or full compensation1. Settled-without-reversal rejects before effects.
- [x] Execute RED->GREEN, SQL cost/count/cleanup and full affected suites, commit new010 checksum deliberately.

### Task5: Funded DVP and reversal

**Files:** Extend unaccepted010/checksum; tests/post-trade/settlement.test.ts,settlement-concurrency.test.ts.
**Interfaces:** SETTLE/REVERSE payload{execution_id,expected_revision,processing_date}; balances and outcome history source-bound. Receipt hash binds whole operation/payload.

- [x] Failing tests for initial100m/0 balanced funding, BUY/SELL postings, unfunded short FAILED/no balance effects, original-key failed replay/new-key retry, two-failure/three-post/three-reverse bounds, exact zero cash, no negative cash/par, opposite conservation.
- [x] Failing tests for reverse-before-correct/bust, insufficient reversal no effects, terminal reversed revision, pending/failed supersession, nondecreasing simulated processing watermark/weekdays/due/window and actual UTC audit immutability.
- [x] Implement locked all-or-nothing balances with two balanced posting/reversal events and one failed-attempt event; immutable per-revision once-only constraints and deferred reconstruction.
- [x] Run concurrent settle/reverse/correct/bust/key races, physical exact costs and both before-/after-COMMIT recovery hooks without raising limits; full affected suites, commit.

### Task6: Complete owned risk/FIFO assessments and APIs

**Files:** Create app/domain/post-trade/assessment.ts,source.ts; app/server/post-trade/service.ts,routes.ts; modify WorkflowRoutes delegation; additive independently authored OpenAPI; tests/post-trade/assessments.test.ts,http.test.ts.
**Interfaces:**

- assessOwned(snapshot:OwnedPostTradeSnapshot,fixtureId,asOf):Assessment (AVAILABLE with source identities/risk/FIFO/equity or UNAVAILABLE with explicit reasons and no invented financial zero).
- Routes under /api/fixed-income/v1/sandboxes/:id/posttrade: initialize,executions/:id/register|corrections|busts|settlements|reversals,commands/:key,risk,pnl,root history/audit pages.
- Current trader+trade for every writer, current owned read/trade capability for reads, generation/current session verification before replay/return. Only explicit local schema10 injection constructs service; hosted/default clients remain off.
- Risk/P&L queries accept fixture/asof and bounded source cutoffs only; never client positions. Both returned assessment identities bind sandbox/generation/source sequences/window/instrument/curve/model.
- Net equity=available cash+signed unsettled cash+signed adjusted marks; equity-opening funding=realized+unrealized. Expose aggregate presentation rounding differences.

- [x] RED tests: uninitialized/empty/offset/unregistered/ninth/unsupported/weekend/out-of-window/closed-flat roots, asof before value date, missing marks, historical cutoff/restatement, no assessment writes.
- [x] RED exact FIFO/equity bridge for buys/sells/short-cover/partial lots/corrections/busts and FAILED/SETTLED/REVERSED settlement; never double realize.
- [x] RED real HTTP status/body tests for roles, cross-sandbox/revoked capabilities, malformed/duplicate/prototype payloads, source-binding and original-key recovery.
- [x] Implement authorized DAO/source admission, pure kernels, strict available/unavailable contracts and additive routes/OpenAPI. Preserve original raw inspection and all old contracts.
- [x] Run independent numerical/accounting comparisons, realSQL/HTTP security/cleanup and full affected suites; commit.

### Task7: Inspectable report, actual native journey and recovery

**Files:** Create scripts/posttrade-local.ts,posttrade-report.ts,verify-posttrade-journey.ts; tests/post-trade/recovery.test.ts,journey.test.ts; verification/python/posttrade_reconstruct.py; docs/PHASE4_POSTTRADE.md.
**Interfaces:** Owned-only local entry point constructs schema10 DB/server. Report consumes authenticated owned source or private owned descriptor, never untrusted positions. Native journey preserves original selected pinned engine profile and current preservation admission.

- [ ] RED deterministic journey: original coupon -> curve/RFQ -> actual D/8/F/9 receipt/replay -> price correction/bust -> funded settlement/reversal -> risk/FIFO bridge, including negative branches and immutable old raw evidence.
- [ ] RED real database/process restart, uncertain COMMIT, capability rotation, historical receipt recovery, full owned cleanup; use barriers, no sleeps.
- [ ] Independent Python reconstructs raw/corrected positions, exact cents/par/FIFO/available/unsettled/equity from immutable receipts and checks all bounded counts.
- [ ] Implement bounded CLI/report/journey and source-bound evidence. If current exact preservation rejects, retain the real refusal; do not run around it or claim the unexecuted native journey passed.
- [ ] Run all currently authorized financial/recovery/security evidence, document each explicit remaining qualification/owner boundary; commit.

### Task8: Whole-scope qualification and review

**Files:** Update evidence/current-state guides, workflow complete-postgres command and explicit proposed preservation manifest only as allowed by owner authorization.

- [ ] Full validate and configured repeat-each2, two fresh complete PostgreSQL passes each including old455 plus all new010 cases, three-browser RFQ baseline/repeats, public artifact/interview/native smoke, audits/build/contracts.
- [ ] Run original43/89 and118/118 gates and new journey only under an owner-accepted exact source contract; retain all first failures. Never relax original assertions, discovery, retries or limits.
- [ ] Record exact current commit/tree and every modified original hash, independent physical97/161 cost derivation, cleanup and explicit scope/clock/receipt interpretations in one reviewable report.
- [ ] One fresh whole-branch review with five focus classes and all rulings. Critical/Important fixes get one observed RED->GREEN pass and full green affected suites; Minor deferred.
- [ ] Human final financial/model/test/exact-preservation acceptance and separately authorized protected integration; no deployment. Complete all reversible authorized work before asking for that final concrete decision.

## Pre-flight and self-review

Task1 RiskVector feeds Task6 serialization without rounding; Task2 EconomicExecution/FifoResult feeds Task6 exact basis/equity. Task3 owns the SQL/DAO source boundary consumed by Tasks4-6 and profile10 needed by7. Tasks4/5 append records exposed by the same bounded source contract; no original raw row is rewritten. Task6 supplies source-bound report/journey in7. Task8 retains all old gates rather than replacing them. Physical010 checksum changes are authoring changes to an unaccepted new migration, never automatic runtime source acceptance.
