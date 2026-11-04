# TradeFlow current state and evidence

Reviewed **November 4, 2026**. This is the current release and navigation index. Historical plans/reports keep their original revisions, measured results and first failures; their earlier candidate/pending wording does not override this index.

## Accepted implementation checkpoint

| Item                | Verified result                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Milestone           | Phase 3C0 — bounded offline FIX session conformance                                                                                                                            |
| Main merge          | [`f31f6e28ea07c4927537c43d797dae8e11b1b85c`](https://github.com/farhan-shafee/institutional-trading-sdet-lab/commit/f31f6e28ea07c4927537c43d797dae8e11b1b85c), GitHub Verified |
| Ordered parents     | Prior main `893f3bbee8e2d7af812c7295e7be679905ba4b8a`; feature `5911cfc01b9607bcf197f59fd98e8218450a13b5`                                                                      |
| Reviewed tree       | `d1e2ad371c620a2df2df3aeed9bc89bd50ab8d99`                                                                                                                                     |
| Release PR          | [#29, merged and closed](https://github.com/farhan-shafee/institutional-trading-sdet-lab/pull/29)                                                                              |
| Main quality        | [41914340404](https://github.com/farhan-shafee/institutional-trading-sdet-lab/actions/runs/41914340404), completed/success, attempt 1                                          |
| Main persistence    | [41914340173](https://github.com/farhan-shafee/institutional-trading-sdet-lab/actions/runs/41914340173), completed/success, attempt 1                                          |
| Mandatory main jobs | 8/8 passed, GitHub Actions app 15368; existing protection preserved                                                                                                            |

This is a source-bound implementation checkpoint. Documentation-only commits may follow it. Use the [main quality history](https://github.com/farhan-shafee/institutional-trading-sdet-lab/actions/workflows/quality.yml?query=branch%3Amain) and [persistence history](https://github.com/farhan-shafee/institutional-trading-sdet-lab/actions/workflows/persistence.yml?query=branch%3Amain) for subsequent exact revisions.

| Verification category                       | Observed result at that checkpoint                                     |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| Node unit suite                             | 966 passed                                                             |
| Independent financial Python tests          | 117 passed                                                             |
| Original FIX verification                   | 7 Python tests and 14 encoded application goldens preserved/passed     |
| Session Python tests                        | 78 passed                                                              |
| Raw session corpus                          | 59 literal expected reports matched; 57 files, 6,100 raw bytes         |
| API/three-browser tests                     | 230 baseline; 460 repeated, in each quality/regression job             |
| Post-merge PostgreSQL                       | Two fresh executions, 455/455 each; zero failures/cancellations/skips  |
| Financial workload per PostgreSQL execution | 247 executions and 44 rotations; all three phases below 30 seconds     |
| Three-browser RFQ workstation               | 99 baseline; 198 repeated                                              |
| Cleanup                                     | Retained capacity returned to zero in PostgreSQL and workstation gates |

PR #29 separately retains the pre-merge 16 hosted checks and local acceptance. Those are not newly executed post-merge work. Later green runs do not establish a causal fix for historical lifecycle `23514` or timeout incidents.

## Public demo versus GitHub/local/CI

### Public demo: separately pinned equities slice

The [public workstation](https://tradeflow.farhan-shafee.com) has isolated in-memory session books, synthetic trader/viewer roles, static positions/quotes and browser-observed activity. November 4 provider reads confirmed the Railway app still pinned to `265c9e0ed1fdc528193cd474d966513decd03d3b`, successful deployment `30ca206b-765b-4fe5-ad22-50a1f2d02aec` released October 25, separate cloudflared ingress and no application database/volume. The later source milestones were not deployed by their merge operations.

See [production topology](RAILWAY_PRODUCTION.md) and the [dated dependency-maintenance release](SECURITY_MAINTENANCE_2026-10-25.md). Reachability is an observation, not an uptime/capacity guarantee.

### Accepted source: later synthetic capabilities

| Implemented source                                    | Guide and boundary                                                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Fixed-income analytics                                | [Conventions](FIXED_INCOME_CONVENTIONS.md), independently checked fictional bond analytics                                  |
| Durable workflow foundation                           | [Persistence](FIXED_INCOME_PERSISTENCE.md), opt-in local PostgreSQL; workflow defaults OFF                                  |
| Dealer RFQ and exact quotation acceptance             | [RFQ](FIXED_INCOME_RFQ.md), synthetic local/ephemeral-CI workflow                                                           |
| Order lifecycle and execution ledger                  | [Executions](FIXED_INCOME_EXECUTIONS.md), immutable executions and derived signed cash/positions                            |
| Reconciliation and exception investigation            | [Reconciliation](FIXED_INCOME_RECONCILIATION.md), historical independent assessments with no repair                         |
| Phase 3A byte/profile layer                           | [FIX 4.4 profile](FIX44_PROFILE.md), bounded application-message bytes                                                      |
| Phase 3B retained evidence and controlled application | [Foundation](FIX44_FOUNDATION.md), [application](FIX44_APPLICATION.md), original-key recovery and finite protected capacity |
| Phase 3C0 offline session contract                    | [Session guide](FIX44_SESSION.md), selected A/0/1/5 administrative transcripts and explicit verdicts                        |

The local FIX application SDK is explicitly server-side and opt-in. The offline session checker does not call it, open a connection or persist session state. Synthetic CompIDs are correlation labels, not authentication. A corpus command succeeds when literal expected reports match, including expected INVALID, INCOMPLETE and OUT_OF_SCOPE cases; not every transcript is conformant.

## Remaining boundaries

3C0 supplies executable reviewed rules before a runtime session engine. It does not implement transport, heartbeat scheduling, durable session state, resend/reconnect recovery, independent-peer interoperability, verified delivery or external completeness. Later session milestones and Phase 4 entries in the [roadmap](plans/PHASE3C.md) remain proposed and require separate contracts/authorization. No production rollout is implied.

All credentials, quotes, orders and executions are synthetic. There is no real venue/dealer connectivity, live market feed, settlement, real-money P&L, production identity/tenant assurance or regulated-trading claim.

## Reproduce and inspect

Start with the [README](../README.md), [test strategy](TEST_STRATEGY.md), [CI gates](CI_CD.md), [fixtures](FIXTURES.md) and [public equities/interview walkthrough](INTERVIEW_DEMO.md). Historical [productization](PRODUCTIZATION.md), [validation](VALIDATION.md), [audit](AUDIT.md) and [delivery](DELIVERY_REPORT.md) retain their original context.

Counts, screenshots and reports belong to their named source/environment. Older captures show the equities slice. CI artifacts expire; source/run/job references retain the revision context. Broader security, availability, performance and peer-interoperability claims require separate evidence.
