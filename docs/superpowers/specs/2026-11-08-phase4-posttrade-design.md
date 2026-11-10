# TradeFlow owned post-trade implementation design

Implements the already owner-approved Phase4C-F financial rules in [the completion contract](../../PHASE4_COMPLETION_CONTRACT.md). This is the engineering design for a reversible local/CI candidate. Final owner model/test acceptance, exact preservation authorization, protected integration and any deployment remain separate.

## Intent and boundaries

Complete owned portfolio risk, append-only price corrections/full busts, funded synthetic settlement/reversal and FIFO dirty-basis P&L. Use the currently authorized sandbox's immutable executions; no client position snapshots, new trading eligibility, deposits, borrowing, coupon/redemption income, fees or live venues.

Phase4B provides immutable curves, exact Rational arithmetic and unrounded marks. The two tradable definition IDs are phase1-ust-1 and phase1-corp-1. Raw execution par may be0.01 following partial fills; preserve it. Corrected consideration may round to zero at very small par and a valid low price; never substitute a minimum cent.

## Approaches and executor choice

| Approach                                                                                                  | Tradeoff                                                                                         | Disposition                                                 |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Rewrite original executions/positions/counters                                                            | Breaks immutable history and the original command/event-count invariants.                        | Rejected by approved preservation rules.                    |
| Separate unbounded ledger with fresh capacity                                                             | Breaks the aggregate512/1024 ceilings and protected FIX capacity.                                | Rejected by approved resource rules.                        |
| Additive010 ledger, separate raw/economic views, shared ownership/key namespace and aggregate reservation | Preserves old semantics while adding bounded compensated effects and explicit source identities. | Executor's implementation choice within the approved scope. |

Use an explicit owned schema10 database client. Schema8 remains the default; schema9 native behavior remains unchanged. Post-trade mode is only constructed for an owned loopback target and explicitly injected by the new local/CI runner. Hosted targets do not activate it.

## Components and storage

Pure risk and FIFO kernels consume validated internal economics. Their public assessment adapter obtains inventory through the authorized SQL read service and checks complete coverage/window constraints before calculation.

Migration010 lives in db/posttrade-migrations and follows exact001-009 checksums. It creates bounded books, registered roots, immutable revisions/busts, immutable settlement outcomes and command/event receipts, plus materialized available balances with deferred consistency checks. Forced RLS/owner policies and least-privilege RPC grants protect all new tables. Existing owned retention cascades remove the complete new graph. No accepted migration file is edited.

The original sandbox command_count/event_count/commit_seq retain their exact legacy ledger meaning. Global usage is legacy counts plus actual post-trade receipt/event counts. Global admission also includes unspent post-trade reservation, unspent FIX reservation and its original security-rotation headroom. No fresh512/1024 allowance is introduced.

Extend the shared command-key registry with a POSTTRADE domain. Preserve007's private FIX_PREPARED-to-FINANCIAL transfer branch exactly; never restore006. Serialize all writers under the original sandbox lock. New reservation guards also protect FIX BIND reservation insertion, not only financial counter updates.

## Bounded command accounting

| Operation             | Maximum | Commands each | Events each |
| --------------------- | ------- | ------------- | ----------- |
| Initialize/fund       | 1       | 1             | 1           |
| Register              | 8       | 1             | 1           |
| Correct price         | 16      | 1             | 2           |
| Full bust             | 8       | 1             | 1           |
| Failed settlement     | 16      | 1             | 1           |
| Successful settlement | 24      | 1             | 2           |
| Reversal              | 24      | 1             | 2           |
| Total                 |         | 97            | 161         |

Initialization reserves97/161 including its own receipt. The remaining allowance is consumed atomically. Pre-admission validation/authorization/revision/operation-limit failures create no effects or key receipt. Accepted FAILED settlement attempts are receipted and bounded to2/root; an original-key retry repeats that failure. Existing stored keys always conflict on changed operation/payload and require current authorization before replay. Unknown COMMIT uses original-key authoritative recovery.

## Dates and explicit executor interpretations

Preserve original agreed value dates. Initialize one immutable start and the first following contractual coupon as exclusive end; all roots, assessments and processing dates obey that window, including closed/flat books. Assessment dates must also be on/after every non-busted active root's value date. Audit timestamps remain real UTC and are never financial trade dates.

Executor interpretation proposed for final owner review: admitted simulated processing dates stay the same or advance, including recorded FAILED attempts; reversals cannot precede their original posting. This prevents using future-dated settled assets to fund an earlier processing date. The accepted contract did not explicitly choose backdated processing support. This implementation does not add a historical backdated-posting engine.

Available balances are bound to the disclosed post-trade command sequence and processing-date watermark; security marks use the separately disclosed economic as-of date. A current economic restatement is not advertised as historical available cash at the mark date. Historical command cutoffs remain reproducible. The clock interpretation and receipt-admission distinction must be visible in final owner scope review.

## Financial effects and reconstruction

Register immutable owned execution roots once, up to8. Price corrections preserve quantity/side/instrument/value date, use original scalar quote/accrual/exact-cash conventions, and append compensation/replacement effects. At most2 corrections and one terminal full bust/root. A posted settlement must successfully reverse before any correction/bust.

Settlement posts exact cents and par in two balanced event records, with equal opposite synthetic counterparty entries. Funding is one balanced opening cash event. Client cash/par never go negative. No partial settlement, borrow, overdraft or automatic reversal.

FIFO is ordered by original execution command sequence and stable ID. Corrections replace economics at that ordering point; busts remove them. Allocate exact cash cents proportionally with Rational arithmetic and round only aggregate outputs. Long/short lot reconstruction must agree with adjusted positions.

Risk uses signed dirty PV, central1bp parallel/four-node measures and the three approved stresses. Aggregate unrounded values. P&L combines exact FIFO realization and dirty curve unrealization, then bridges available cash plus signed unsettled cash plus adjusted signed marks to opening funding. Presentation differences are disclosed without altering posted cash or basis.

## Failure and acceptance

Missing initialization, a ninth/unregistered/unsupported/out-of-window root, missing evidence or an invalid economic assessment state returns explicit unavailable, never zero. Verified empty/offset inventory may return true zero. Stateless assessments perform no durable writes.

Use existing pool4/pending12,500ms checkout,2s query,1500ms statement,750ms lock,2s idle transaction,5s deadline and3 pre-COMMIT deadlock retries only. Do not increase any deadline, resource ceiling or retry.

Every slice uses observed RED/GREEN, real SQL ownership/concurrency/recovery tests, separate Python numerical/FIFO reconstruction and retained first failures. Final complete PostgreSQL passes each include the original455 schema8 scenarios plus the new owned schema10 suite. Original native43/89 and118/118 gates remain mandatory; a new source-bound actual FIX/post-trade journey is added, never substituted for them. Current source preservation remains enforced; new exact pins require owner acceptance before successful final native qualification is claimed.
