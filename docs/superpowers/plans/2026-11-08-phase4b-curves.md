# TradeFlow Phase4B Synthetic Curves Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add immutable synthetic discount-curve snapshots, cash-flow valuation and continuous z-spread analytics with independent numerical evidence.

**Architecture:** Keep the scalar v1 and zero v2 models unchanged. New pure modules use exact rational cash-flow/accrual/exponent coefficients and an isolated 80-digit HALF_EVEN exponential context. Authenticated read routes accept only named fixture/date inputs; no editable market data or trading eligibility is introduced.

**Tech Stack:** TypeScript, decimal.js, Zod, Node tests, Python Decimal/Fraction, existing Playwright/OpenAPI infrastructure.

**Spec:** docs/PHASE4_COMPLETION_CONTRACT.md sections 4B and shared acceptance/resource rules; owner-approved November8,2026.

## Global Constraints

- Model DISCOUNT_LOG_LINEAR_ACT365F_V1; USD; fixtures BASE_UP_V1, FLAT_V1, NEGATIVE_V1 and exact nodes/rates from the approved contract.
- Days 0/365/730/1825/3650, implicit DF(0)=1, actual calendar days/365, log-linear interpolation, no extrapolation.
- As-of 2025-01-15 through 2031-01-14; three approved instruments only; cash flows on/before as-of excluded.
- Preserve original schedules, coupon amounts and both original unrounded day-count accrual conventions. No changes to v1/v2 formulas, definitions or tradability.
- Spread [-0.10,1.00], at most200 bisection iterations and absolute per100 residual <1e-24; endpoint price allowance0.00000000005 only.
- Decimal80 HALF_EVEN; price/accrual10dp, spread12dp, mark USD2dp. Snapshots expose DF20dp while calculations retain80 digits.
- Independent Python Decimal >=120 digits with safeguarded Newton, price tolerance5e-10, spread2e-11, finite golden mark-cent agreement.
- Marks never decide posted cash. Ambiguous numerical half-cent boundaries fail explicitly; analytically exact rational boundaries use exact HALF_EVEN.
- No timeout/retry/capacity increase, no live inputs or hosted activation. Original001-009 migration bytes and all historical tests remain intact.
- Current preservation-v2 exact two-file A exception does not authorize future route/schema bytes; retain the guard and report any later exact replacement approval separately.

## Review Focus

- A flat curve plus exactly opposite spread must cancel before exponential rounding; exact half-cent marks receive exact HALF_EVEN (Task3).
- As-of cash flows and leap-day accrual must use original semantics rather than rounded v1 display fields (Task1).
- Snapshot identity must bind canonical immutable metadata, and caller mutation must not change later calculations (Task2).
- Near-maturity endpoint quotes must neither expand the spread domain nor fail legitimate displayed-price round trips (Task3).
- Missing/extra/duplicate/prototype query fields and both/neither quote modes must fail through authenticated real HTTP status/body assertions (Task4).

---

### Task1: Exact financial numbers and contractual cash flows

**Files:** Create app/domain/fixed-income-v3/numbers.ts, cash-flows.ts; tests/unit/curve-cash-flows.test.ts.
**Interfaces:**

- Rational immutable normalized numerator/denominator bigint; decimal(text), add/sub/mul/div, isZero, toDecimal(), fixed(places).
- curveCashFlows(instrumentId: CurveInstrumentId, asOf: string): { instrument_id, definition_version, accrued: Rational, remaining: readonly {payment_date, amount_per_100: Rational, days: number}[] }.
- CurveInstrumentId is the union of original two IDs and SYN-ZERO-2031. Original coupon definition versions reuse the existing immutable database IDs phase1-ust-1 and phase1-corp-1; no replacement definitions.

- [x] Write failing tests: correct zero redemption, coupon-date exclusion, maturity principal, leap-day accrual(UST45/91, CORP22/45 per100), strict dates/unsupported IDs, exact signed HALF_EVEN ±1.275 ->±1.28 and ±1.265 ->±1.26, rational partial allocation.
- [x] Run focused tests; expect missing-module failure before implementation.
- [x] Implement exact normalized immutable rational arithmetic, bounded public decimal parsing at callers, original schedule/date helpers and unrounded accrual from integer elapsed/period.
- [x] Run focused tests, typecheck, lint; all pass.
- [x] Commit task.

### Task2: Immutable curve snapshots and interpolation

**Files:** Create app/domain/fixed-income-v3/curves.ts; tests/unit/discount-curves.test.ts.
**Interfaces:**

- curveSnapshot(fixtureId: CurveFixtureId, asOf: string): CurveSnapshot (deep readonly/frozen).
- Snapshot contains model_version, currency, fixture_id, as_of_date, canonical nodes{offset_days,zero_rate}, snapshot_id SHA256. Display DF is derived and excluded from identity; canonical identity serializes version/model/currency/fixture/asof/four fixed12dp rate nodes in fixed property order.
- curveExponent(snapshot, days, spread: Rational, shocksBp?: readonly four rational values): Rational; returns the exact negative integrated rate before exp.
- discountFactor(snapshot, days, spread='0', shocksBp?): Decimal80. Only internally constructed and validated snapshots are consumed.

- [x] Write failing tests for literal flat DF day365=0.97044553354850817693/day730=0.94176453358424870954, negative DF>1, day0=1, every knot/midpoint, last supported day3650, reject -1/3651/noninteger/NaN/infinity, fixture/date/schema and identity tampering.
- [x] Run focused tests; expect missing-module failure.
- [x] Implement fixed fixtures, exact rational log-DF interpolation (no exp/log round trip), canonical SHA binding and deeply immutable snapshots.
- [x] Run task1+task2 focused tests, typecheck/lint.
- [x] Commit task.

### Task3: Curve PV and bounded continuous spread

**Files:** Create app/domain/fixed-income-v3/analytics.ts, contracts.ts; tests/unit/curve-analytics.test.ts, curve-oracle.test.ts; verification/python/curves.py.
**Interfaces:**

- curveAnalytics(input: unknown): CurveAnalytics strict wire result. Input instrument_id,fixture_id,as_of_date,par_amount and exactly one z_spread/clean_price; decimal grammar/ranges follow approved v1 input bounds.
- curveMeasure(snapshot, instrumentId, spread, optional shocks): {dirty: Decimal80,clean:Decimal80,accrued:Rational,flows,exact_dirty?:Rational}; unrounded internal marks support later risk.
- solveSpread(snapshot, flows, exactTarget): Decimal80; no caller-selectable iteration/tolerance.
- Wire result includes instrument definition/model/curve snapshot identity, asof/par/spread,clean/dirty/accrued,mark_value_usd,remaining cash flows and explicit conventions. No consideration or settlement-cash field.
- roundCurveMark(value, numericalAllowance, exactValue?): fixed2 string or NumericalAmbiguityError; use conservative error allowance1e-50 USD (far above bounded80-digit operation error) and exact rational proof when all flow exponents are zero or quote target is rational.

- [x] Write failing literal forward cases, inverse roundtrips/negative spreads, near-maturity bracket boundaries and just-outside tolerance, invalid input, exact cancellation/half-even marks, dirty-minus-unrounded-accrued, huge-par cents regression, global Decimal context isolation, explicit ambiguous-boundary refusal.
- [x] Run missing implementation tests RED.
- [x] Implement forward PV, monotone200-step bisection with residual gate, exact quoted target preservation, exact-rational zero-exponent mark and numerical ambiguity admission.
- [x] Independently implement Python120+digit cash-flow schedule/accrual/DF/PV and safeguarded Newton; do not import TypeScript/generated application data.
- [x] Compare at least144 forward cases spanning3fixtures/3instruments/4dates/4spreads, representative inverse solves plus endpoint/nearmaturity/literal cent cases. Expected all tolerances and cents pass, no skipped discovery.
- [x] Run all focused tests and full unit suite/typecheck/lint.
- [x] Commit task.

### Task4: Authenticated curve reads and inspectable evidence

**Files:** Modify app/server/fixed-income.ts and contracts/openapi.yaml additively; create tests/api/fixed-income-curves.spec.ts; docs/PHASE4B_CURVES.md; CLI scripts/curve-analytics.ts; update docs/PHASE4_ECONOMICS.md.
**Interfaces:** GET /api/fixed-income/v3/curves?fixture_id=&as_of_date=; GET /api/fixed-income/v3/analytics with Task3 query. Both current roles read; no writes; unknown/repeated parameters rejected. CLI reads JSON query input and emits the same typed result without credentials or network.

- [ ] Write failing HTTP tests for401 anonymous,200 trader/viewer, unchanged owned books/v1/v2 catalogue, independent OpenAPI validation,400 missing/extra/duplicate/prototype/scientific/range inputs, safe explicit numerical-ambiguity response. Assert actual status and body.
- [ ] Run focused HTTP tests RED.
- [ ] Implement additive route dispatch and independently authored OpenAPI schemas; leave original paths/schemas structurally identical.
- [ ] Run focused HTTP tests, full validate and repeat-each2, no retries. Independently verify source preservation changes and retain any exact native gate refusal; no automatic hash acceptance.
- [ ] Document oracle discovery/counts, accepted numerical rules, explicit unsupported states and current integration boundary; commit.
- [ ] One fresh whole-branch review; Important/Critical fixes RED->GREEN then green full suite, deferred minor ledger. Human final code/model/test acceptance and exact future preservation changes remain explicit before protected integration.

## Pre-flight and self-review

Task1 exact Rational/flow interfaces are consumed without re-rounding by Task2/3. Task2 snapshots/exponents feed Task3 PV and later Phase4C scenarios. Task3 result/schema feed Task4 APIs/CLI; raw authoritative inventory remains outside stateless4B. Scope covers every4B requirement and keeps later4C-F owned inventory/storage work separate. Original coupon source identity must be read from the current v1 financial contract, not invented.
