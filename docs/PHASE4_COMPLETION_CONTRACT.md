# Approved TradeFlow Phase4 completion contract

The owner accepted the financial scope and exact Phase4A two-file API exception on November8,2026, replying Yes to the linked completion contract and PR37 review decisions. This authorizes scoped preservation implementation, qualification and continued engineering work. Production deployment remains separate.

The snapshot below is the exact version1 contract reviewed by the owner. Its candidate/blocker and execution-receipt paragraphs describe the pre-approval state; current implementation evidence belongs in CURRENT_STATE.md. No later code or qualification is implied by this snapshot.

---

# TradeFlow Phase 4 completion contract - candidate

Prepared November 8, 2026. Status: proposed financial scope for human review; only the Phase 4A code candidate exists. This document proposes the remaining financial rules. Phase 4B-F are unimplemented.

## Review decision

Accept or revise the finite contracts below and the exact two-file API preservation exception in [draft PR #37](https://github.com/farhan-shafee/institutional-trading-sdet-lab/pull/37). Once accepted, these become the financial specification for the remaining engineering work. Final code, tests, independent evidence and release disposition still need human acceptance.

The target is **synthetic engineering completion in local/CI**. Updating the public demo is a separate later release. No live venues, external feeds, real funds, regulated certification, actual custody or real securities settlement. Do not call this production financial readiness.

Preserve original instrument/model identities, formulas, historical goldens, immutable execution/command/audit records, migrations 001-009, original test assertions, all resource/time limits, two fresh full PostgreSQL passes and configured three-browser baseline/repeated workloads. New models are additive and explicitly versioned. No automatic source-hash acceptance or general preservation ignore rule.

## 4A - additional instrument

The candidate in PR #37 adds SYN-ZERO-2031, definition SYN-ZERO-2031_V1, model ZERO_SIMPLE_ACT365F_V1. Fictional USD principal-only, dated 2025-01-15, maturity 2031-01-15, one 100-per-100 redemption. No periodic coupon or accrued interest.

Simple annual yield: t=actual UTC calendar days to maturity/365; price 100/(1+y*t), inverse(100/price-1)/t. Strict decimal strings, par 1 through 1000000000 with at most 2 fractional digits; yield [-0.10,1.00] or positive clean price <=10000, exclusively. Quote must imply that yield bracket, allowing only half a displayed price quantum at endpoints. Settlement lies in [dated,maturity). Exact rational cash, HALF_EVEN once to cents; displayed price never decides cash. Prices: 10dp, yield: 12dp.

Separate authenticated read-only v2 catalogue/analytics; original v1 catalogue remains two coupon-bond profiles. The zero instrument is **not RFQ/order eligible** in this scope. Its cash-flow/valuation lifecycle is supported through pre-maturity analytics; maturity/post-maturity yield is rejected. New-instrument trading, floating/stub/callable/amortizing/inflation/FX/tax products are explicitly unsupported.

## 4B - versioned synthetic discount curves and spreads

Model DISCOUNT_LOG_LINEAR_ACT365F_V1. Three named synthetic USD fixtures, each with four continuously compounded annual zero-rate nodes:

| Fixture     | Day 365 | Day 730 | Day 1825 | Day 3650 |
| ----------- | ------- | ------- | -------- | -------- |
| BASE_UP_V1  | 0.02    | 0.025   | 0.03     | 0.035    |
| FLAT_V1     | 0.03    | 0.03    | 0.03     | 0.03     |
| NEGATIVE_V1 | -0.01   | -0.01   | -0.01    | -0.01    |

Each node offset is an exact number of calendar days after the requested as-of date, not a calendar-year anniversary. t=days/365. Node DF=exp(-r*t); implicit as-of node DF(0)=1. Interpolate linearly in log DF between adjacent nodes. Do not extrapolate beyond day 3650 or before as-of. Negative rates and DF>1 are valid; DF must remain positive and finite.

As-of is a strict Gregorian date from 2025-01-15 through 2031-01-14. The immutable snapshot identity binds fixture version, as-of date, all node offsets/rates, currency and model version with a canonical SHA256. No live market inputs or editable stored curve definitions.

Price the approved three instrument definitions from contractual future cash flows, excluding payment on/before valuation date. Original coupon amounts/schedules/day-count accrual stay exactly as written in the original fixed-income contract. Curve discounting is a separate model and must not be substituted for scalar v1 YTM. For zero, accrued=0. For coupon bonds, curve clean=curve dirty minus original unrounded accrued interest.

Continuous z-spread multiplies each DF by exp(-z*t). Spread range[-0.10,1.00]; solve against exact supplied clean plus unrounded accrued using bounded bisection, maximum 200iterations, absolute per100 price residual <1e-24. Reject out-of-bracket/unconverged targets; allow only half displayed-price quantum at wire-round-trip boundaries. No periodic spread, bootstrap, credit/default or extrapolation claim.

New exponential curve/risk calculations use an isolated 80-significant-digit HALF_EVEN context; outputs price/AI: 10dp, rate/spread: 12dp, dollar valuation: 2dp, risk dollars: 8dp. Independent Python Decimal uses at least 120 digits and a different safeguarded solver. Required oracle tolerances: price5e-10 per100, spread2e-11 annual decimal, reported valuation agreement to cents for the finite approved goldens. Near rounding boundaries use higher precision or return an explicit numerical-ambiguity error rather than guessing a posted amount. Curve valuations are marks, never posted settlement cash.

## 4C - portfolio risk and named stress

Risk source is the currently authorized sandbox's authoritative execution inventory, adjusted only by accepted append-only Phase 4D effects. Never accept a client-supplied position snapshot as owned inventory. Attach sandbox/generation, raw execution sequence, adjustment sequence, instrument versions and curve snapshot identity to each assessment.

Phase 4D registration is bounded to eight original execution roots. Portfolio results may claim complete economic coverage only if every raw execution root through the assessment source sequence is registered and supported. A ninth/unregistered/unsupported root makes the post-trade risk/P&L assessment unavailable with explicit reasons; never silently omit it. Original raw execution-derived positions remain inspectable and clearly distinct from the adjusted economic view.

Signed par: BUY positive, SELL negative. Aggregate unrounded PV in USD before output rounding. Central parallel DV01=(PV with all zero nodes down 1bp minus PV with all nodes up 1bp)/2, positive for a normal long bond. Key-rate dollar DV01 uses the same symmetric 1bp bump at only one of the four nodes, reapplying the declared interpolation. Do not present the finite-bump sum of key rates as exactly equal to parallel risk.

Stress P&L=shocked PV-base PV with fixed source positions and accrual:

| Scenario          | Node shocks in bp, day 365/730/1825/3650 |
| ----------------- | ---------------------------------------- |
| PARALLEL_UP_100   | +100,+100,+100,+100                      |
| PARALLEL_DOWN_100 | -100,-100,-100,-100                      |
| STEEPENER_V1      | -50,-25,+25,+50                          |

Return per-instrument and aggregate signed PV, parallel DV01, four key-rate dollar DV01s and three stress P&Ls. No portfolio duration ratio when net PV is zero; this scope exposes dollar measures instead. Verified empty or offset inventories may return true zero; missing source/curve/instrument evidence returns unavailable, never zero. Required independent risk tolerance=max(0.000001USD,1e-8*absolute oracle result) for unrounded dollar measures; displayed scales remain as above.

## 4D - immutable corrections and busts

Only the two originally tradable coupon-bond profiles are eligible. Reference an existing immutable owned execution by its original execution identity. Register that execution root once, preserving the original recorded par, side, instrument, clean price, settlement date and exact cash. Caller cannot mint an execution or choose another sandbox's identity.

Allow at most two price corrections and one terminal full bust per registered root. Correct only clean price, using the original approved quote/accrual/exact-cash conventions; par/side/instrument/original quoted settlement date cannot change. A correction supersedes the currently active revision and requires its expected revision. A bust removes the complete active execution effect, even when that execution was a partial fill of its parent order. No partial-quantity bust, order reopening, new FIX correction message or historical execution rewrite.

Each accepted change appends a compensating/replacement adjustment and its command/audit receipt atomically. Original order/FIX receipts and raw execution ledger stay unchanged. Current adjusted positions/cash/basis reflect the active revision; older as-of-sequence assessments remain reproducible. The original quoted settlement date is the economic value date and never changes. No authoritative financial trade date is inferred from an audit timestamp. Correction recorded time is server UTC and is never backdated. Views disclose source sequence, economic value/as-of dates and actual recorded times, making current economic restatement distinct from historical observations.

A posted settlement must be successfully reversed before its execution can be corrected/busted. Do not auto-reverse, ignore a posted obligation or alter balances during a correction. Busted root is terminal. Require current trader+trade capability, sandbox generation, idempotency key and expected revision. Identical original-key retry returns the original outcome; changed payload conflicts. Authorization/recovery precede replay. Concurrent writers serialize under the owned sandbox lock. Unknown COMMIT stays unknown until original-key authoritative recovery.

## 4E - synthetic trade settlement

Model SYNTHETIC_GROSS_AGREED_DATE_WEEKDAYS_V1. Gross, all-or-nothing delivery-versus-payment per active execution revision. Paper opening balances at post-trade initialization: USD 100000000.00 available cash and zero securities. Record an equal opposite synthetic funding counter-entry. No deposits/withdrawals, borrowing, overdraft, margin, netting, partial settlement, fees, FX, coupon-income payment or principal-redemption posting in this finite scope.

The immutable original quoted settlement_date is the agreed economic value/due date; preserve its original accrued/cash economics. No T+1, trade-date or cutoff is inferred from decided_at/recorded_at, which are audit timestamps. Only roots whose agreed value date is Monday-Friday are eligible; a weekend root is unsupported and makes complete post-trade coverage unavailable. No holidays or market-calendar claim.

Initialization chooses a strict Gregorian economic_start_date within the original dated-to-maturity range. The exclusive economic_end_date is the first contractual coupon date strictly after that start across the two tradable profiles. Every registered root's agreed settlement date, every settlement processing date and every risk/P&L economic as-of date must lie in [economic_start_date,economic_end_date). An assessment must additionally be on/after every non-busted root's value date through its bound source sequence. Once a root exists, an out-of-window raw execution makes coverage unavailable; do not silently omit it or move the initialized window.

Settlement attempts carry an explicit simulated processing date, a weekday on/after the agreed due date and before economic_end_date. Late processing within that window is supported. Economic processing dates can differ from actual UTC audit timestamps: this is an explicitly dated historical/hypothetical simulation, with both dates exposed, not a claim that settlement occurred in wall-clock time. Audit timestamps are never rewritten.

Obligation states: PENDING, FAILED, SETTLED, REVERSED, VOIDED. For BUY, debit exact original/corrected execution cash and credit par; SELL debits owned available par and credits exact cash. Insufficient cash/securities yields FAILED with no balance posting. A failed original-key retry repeats that failure; a new key may attempt again within the finite attempt budget. Unfunded short sells can exist as executions/short lots but cannot settle without owned securities; no borrow facility is implied.

At most two failed attempts, three successful postings and three reversals per execution root across its maximum three revisions. Each revision can post at most once and reverse at most once. Reversed revision is terminal for settlement; correction may then create a new revision's obligation. While an active trade remains reversed, its original signed unsettled cash obligation is restored and disclosed, so reversal alone does not change economic P&L. Bust/correction voids any pending/failed obligation it supersedes; settled obligations must first reverse.

Reversal is one atomic inverse cash/securities posting referencing its original settlement. Require sufficient available cash/par to reverse without a negative client balance; otherwise reject with no effect. Always append equal opposite synthetic counterparty entries. Check per-currency cash and per-instrument par conservation. Duplicate attempts, receipts or race winners cannot double post. Expose pending/failed/settled balances and signed unsettled receivables/payables separately; execution consideration is not settled cash.

## 4F - FIFO dirty-basis valuation and P&L

Model FIFO_DIRTY_USD_V1. Use the same complete registered/corrected authoritative execution set and versioned curve marks. FIFO ordered by original execution command sequence and stable execution identity; a price correction replaces that root's economics at its original ordering position, a bust removes it. History remains append-only; each stored assessment binds its original source sequence and is never overwritten.

Maintain long lots and short-sale lots. A sell consumes oldest long lots before opening a short; a buy covers oldest short lots before opening a long. Use the execution's exact posted-to-cents consideration as acquisition cost or sale proceeds. Partial lot allocations stay exact rational fractions; do not round at each allocation. Report only after aggregate calculation.

Long realization=sale proceeds allocated to closed par minus FIFO acquisition basis. Short realization=allocated original short-sale proceeds minus cover consideration. Realization is recognized in original execution sequence when a lot is closed, not again at settlement. The economic as-of/window constraints above apply; actual recorded timestamps remain audit evidence and are not invented financial trade dates. Unrealized long P&L=dirty curve market value minus remaining long cost; unrealized short P&L=remaining short-sale proceeds minus dirty curve value to cover. Total P&L=realized+unrealized. Dirty basis deliberately includes accrued interest; separate clean/accrued attribution, tax, financing, fees and FX are outside scope.

No coupon or redemption cash postings are implemented in 4E. The fixed initialization window in 4E therefore constrains every execution root and every assessment, including roots that have since closed and flat books. Reject any root/assessment/settlement date at or beyond economic_end_date, even if current net par is zero; do not invent coupon income or allow a fully closed holding to hide an unpaid coupon. This intentionally conservative one-coupon-period scope avoids all coupon/redemption crossings. Existing standalone maturity cash-flow analytics remain distinct from this bounded holding-window P&L contract.

Reconcile net equity=available cash + signed unsettled receivables/payables + signed security marks. Use adjusted economic security positions, including unsettled trades, for signed marks; available settled par is reported separately. Net equity minus opening paper funding equals total P&L, with no settlement double count. Cash/positions and lot reconstruction must agree for buys, sells, short/cover, partial lots, flat books, failed/posted/reversed settlement and price correction/bust. Missing marks or incomplete registration return unavailable.

## Resource and storage contract

Post-trade is default-OFF and initialized explicitly for one owned sandbox. At most eight execution roots. Reserve the entire finite post-trade budget only from currently unreserved headroom; do not raise 512-command / 1024-event ceilings, borrow from B2's 25-command / 43-event reservation or increase any timeout/retry/resource limit.

| Operation                 | Maximum per sandbox | Commands each | Audit events each |
| ------------------------- | ------------------- | ------------- | ----------------- |
| Initialization/funding    | 1                   | 1             | 1                 |
| Register original root    | 8                   | 1             | 1                 |
| Price correction          | 16                  | 1             | 2                 |
| Full bust                 | 8                   | 1             | 1                 |
| Failed settlement attempt | 16                  | 1             | 1                 |
| Successful settlement     | 24                  | 1             | 2                 |
| Settlement reversal       | 24                  | 1             | 2                 |
| Total worst case          |                     | 97            | 161               |

Initialization's 97-command / 161-event allocation includes its own actual receipt; remaining unused reserved capacity is protected from unrelated writers and consumed atomically by actual post-trade commands. Already-exhausted operation/root limits reject before effects; schema-level locks and constraints enforce these bounds. Do not claim this static budget is proven until independent SQL accounting and boundary/concurrency tests derive every count.

Read-only source-bound risk/P&L assessments are deterministically recomputed, not arbitrary unbounded durable writes. If durable assessment storage is later desired, it requires a new explicitly counted scope revision. All returned assessment identities bind canonical input versions and the exact source sequence.

Use an additive migration010 with owned tables/functions, forced RLS and least-privilege RPC grants; preserve migrations001-009 bytes/checksums and all existing role/capability denials. The application must fail closed on schema/source incompatibility. Extend owned recovery, retention and full-graph cleanup for all new records and reservations. New reservations must not alter the behavior of existing sandboxes where post-trade was never initialized.

## Visibility and accounting presentation

Expose every selected capability through authenticated local/CI APIs and an inspectable CLI/report journey. Curves are stateless reads; risk and P&L require current owned sandbox evidence; every writer requires trader plus trade capability and original-key recovery. No new public UI or hosted feature activation is included.

The 512-command/1024-event ceilings apply to the aggregate of legacy and post-trade records, regardless of table namespace; post-trade does not receive a separate fresh 512/1024 allowance. Use unrounded measures for the equity/P&L bridge, round once for reported aggregates, and expose any presentation rounding reconciliation rather than forcing displayed components to add by altering cash or basis.

## Required implementation and acceptance evidence

1. Independent cash-flow/DF/PV/spread/risk goldens and exact FIFO/accounting reconstruction, plus literal adversarial rounding cases; shared written conventions are a modeling assumption, not external certification.
2. Current role/RLS/cross-sandbox/revoked-capability denials; original-key replay with reauthorization; conflicting keys/revisions, concurrent writers and uncertain-COMMIT recovery.
3. Every financial writer's exact command/event cost, reserved/free boundary exhaustion, no effect on failure and owned cleanup. Original455 PostgreSQL scenarios and original semantic assertions preserved; add new coverage.
4. One deterministic journey: original coupon instrument -> curve/RFQ -> execution -> owned native FIX receipt/replay -> correction/bust -> funded synthetic settlement/reversal -> portfolio risk/FIFO P&L. Include negative branches and reconcile independent economic/protocol/cash/par/basis evidence.
5. Original-key recovery after crash/restart and capability rotation, retained immutable history, explicit unavailable assessments, deterministic barriers rather than sleeps.
6. One exact final integrated commit/tree with complete applicable first-attempt gates, two fresh complete PostgreSQL passes, configured three-browser baseline/repeated workloads, audits/static/contracts/build/native smoke, native session and live-application matrices. Preserve every first failure; do not accept a retried/flaky pass or skip mandatory discovery.
7. Independent code/evidence review with no unresolved Critical/Important finding. Owner human financial/model/test acceptance. Separately authorized protected integration and explicit deployment disposition.

## Executed work and current blocker

Draft PR #37 source 6bb7741a8664ccd5ae0f078dc86423dfe3eb25bd, tree 5b8b390fc560296e51e2335caefddb728c730ea9. Local full validate passed 240 baseline cases; repeats passed 480 with retries 0. Final post-review full unit suite 1046/1046,69 Fraction oracle cases, 10 new API tests; typecheck/lint/format/OpenAPI/build/native-production smoke passed.

Independent review found no present calculation/security defect. An Important penny-regression coverage gap was closed: par999999999.83/yield0.04 gives961538461.38; using displayed price gives961538461.37. An isolated faulty calculation failed two assertions; the unchanged real implementation passed 9/9 focused tests and the full unit suite. Minor deferred: committing near-maturity half-quantum boundary regressions; the reviewer executed those four boundaries and 4,382 endpoint round trips successfully.

Native FIX qualification remains blocked by the unchanged 434-file preservation guard. Exactly app/server/fixed-income.ts and contracts/openapi.yaml add the v2 API; all other 432 historical hashes remain intact. Original 38 OpenAPI paths / 61 schemas remain structurally identical. The exact additive route changes can be removed to recover the original route bytes. The guard correctly returns SOURCE_PRESERVATION locally and in hosted native jobs. No preservation exception is installed.

The requested exception is only the exact reviewed API route/schema bytes in PR #37. Retain the original manifest; any approved new version must bind these replacements and all other original hashes, freeze its own inputs, retain tampering negatives and rerun both complete native gates. Do not expand that exception to unrelated future writer, model, migration or verifier changes.

The public Railway service was read-verified still live at its explicit b0216022cb8ff18de904efea9279c91b3977d55f source pin, deployment 8d174084-7f30-40cb-a026-fa90f231c4a0, with no staged changes. Protected main remains d7f6c468fb8ee2581b90935701505a464c189346. Phase 4 remains unfinished.

## Design review disposition

A fresh financial-software builder review identified two blocking specification issues: using audit timestamps as a financial trade date, and allowing a fully closed holding to hide an unpaid coupon. This revision resolves both by honoring immutable agreed settlement dates and enforcing one fixed coupon-period window across every root, settlement and assessment, including flat books. These are proposed scope choices for human acceptance; no Phase 4B-F writer or migration exists yet.

## Proposed numerical examples, not implemented outputs

The following values are independently calculated from this proposed written contract with 120-digit Python Decimal/Fraction arithmetic. They are specification examples, not evidence that Phase 4B-F code exists.

| Proposed calculation                                  | Reference value          |
| ----------------------------------------------------- | ------------------------ |
| FLAT_V1 DF at day365                                  | 0.97044553354850817693   |
| FLAT_V1 DF at day730                                  | 0.94176453358424870954   |
| Zero redemption per100 at one year, flat3% continuous | 97.04455335485081769325  |
| One-year zero parallel DV01, long par1000000 USD      | 97.04455351659174003221  |
| Coupon profile dirty PV per100 at2030-01-15, flat3%   | 100.95591122044200306335 |

FIFO bridge example within the same economic window: BUY par100 for exact cash100.88, then SELL par40 for exact proceeds43.80, both value-dated2030-01-15. Remaining basis60.528; realized P&L3.448. Mark the remaining par60 with the coupon curve PV above: market value60.57354673226520183801, unrealized P&L0.04554673226520183801, total P&L3.49354673226520183801. The same total follows from -100.88+43.80+remaining market value; settlement timing cannot realize it a second time. These are pre-report-rounding quantities.

## Final hosted verification receipt

All eight push/PR workflows completed on their first attempts for source 6bb7741a8664ccd5ae0f078dc86423dfe3eb25bd. Across both triggers: **16 application/persistence jobs passed; four native jobs failed with SOURCE_PRESERVATION**. No rerun, cancellation or native qualification is claimed.

| Trigger | Quality                                                                                            | Persistence                                                                                                   | Native session                                                                                      | Native application                                                                                  |
| ------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| PR      | [Passed](https://github.com/farhan-shafee/institutional-trading-sdet-lab/actions/runs/42480729135) | [All 7 jobs passed](https://github.com/farhan-shafee/institutional-trading-sdet-lab/actions/runs/42480729198) | [Blocked](https://github.com/farhan-shafee/institutional-trading-sdet-lab/actions/runs/42480729128) | [Blocked](https://github.com/farhan-shafee/institutional-trading-sdet-lab/actions/runs/42480729120) |
| Push    | [Passed](https://github.com/farhan-shafee/institutional-trading-sdet-lab/actions/runs/42480699192) | [All 7 jobs passed](https://github.com/farhan-shafee/institutional-trading-sdet-lab/actions/runs/42480699172) | [Blocked](https://github.com/farhan-shafee/institutional-trading-sdet-lab/actions/runs/42480699216) | [Blocked](https://github.com/farhan-shafee/institutional-trading-sdet-lab/actions/runs/42480699186) |

Each full PostgreSQL pass ran 455 tests, with zero failures, cancellations or skips and retained capacity returned to zero. PR A/B jobs 128731864292/128733318325; push A/B jobs 128731777357/128734641719. Both quality and regression profiles confirm 1046 units and 240/480 baseline/repeated API/browser cases. Workstation profiles passed 99/198 cases and their interview/public artifact checks.

This evidence establishes the reported application/persistence results. It does not substitute for the blocked native gates, human financial acceptance, final integrated Phase 4 closeout or deployment.
