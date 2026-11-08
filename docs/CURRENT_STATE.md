# TradeFlow current state and evidence

Reviewed **November 8, 2026**. The public institutional workflow is accepted and deployed at `b021602`. The app remains explicitly pinned when subsequent documentation commits merge. Earlier milestones below retain their exact source/counts and first-failure evidence.

## Phase4A candidate - November8,2026

The feature candidate adds a separate fictional zero-coupon analytics model and authenticated read-only v2 API. It is not accepted, merged or deployed. The v1 catalogue and calculations remain unchanged; the new instrument is not RFQ/order eligible. See [the economic contract](PHASE4_ECONOMICS.md) and [the concrete review decisions](PHASE4A_REVIEW.md).

All1046 unit tests and all10 new API tests passed at slice level. The existing434-file preservation gate correctly blocks the two additive API integration files; the manifest and guard remain unchanged pending explicit scoped review. Full native qualification is not established for this candidate. Phase4B-F and final cross-phase closeout remain unfinished.

## Current public release

[PR #32](https://github.com/farhan-shafee/institutional-trading-sdet-lab/pull/32) merged as GitHub-verified `b0216022cb8ff18de904efea9279c91b3977d55f`, tree `0312dae0a6fe0e9b3e460343dec9a0ac3f7cf5ca`. [Main quality](https://github.com/farhan-shafee/institutional-trading-sdet-lab/actions/runs/42221089925) and [main persistence](https://github.com/farhan-shafee/institutional-trading-sdet-lab/actions/runs/42221090065) passed all eight jobs on first attempts. Both PostgreSQL runs passed 455/455 with zero failures/cancellations/skips and retained capacity zero.

The canonical public domain passed analytics/RFQ/execution/cancellation/reconciliation in Chromium, Firefox and WebKit, including 4002-cent execution consideration, genuine clean merge/tree provenance, reload, read-only viewer and cross-visitor isolation. Dedicated PostgreSQL 17.10/TLS and its owner-authorized restart passed. See the [release receipt](PUBLIC_WORKFLOW_RELEASE_2026-11-06.md) and [production runbook](RAILWAY_PRODUCTION.md) for actual deployment IDs, policy, certificate operation, rollback and limits.

## Local FIX runtime and financial ingress - November 8, 2026

[PR #34](https://github.com/farhan-shafee/institutional-trading-sdet-lab/pull/34)
merged normally as GitHub-verified
6aabe3416ee5977d85bc943e346f5ded34d3bb5c, preserving the qualified runtime tree.
All nine post-merge CI jobs passed. The standalone Phase 3C1 matrix remains
43 scenarios / 89 controls. Both pinned engines use the explicit TradeFlow
matching-TestRequest response guard; no upstream FIX certification is claimed.

[PR #35](https://github.com/farhan-shafee/institutional-trading-sdet-lab/pull/35)
merged normally as GitHub-verified d92c91321758e6beff5d52c58c565bc3a29be51a with the qualified108-control tree. Its first resulting main live run42452152303 failed during native cleanup with LIVE_FORWARD_OS_9 after persisted-order replay; that first-attempt evidence is retained. The follow-up corrects normal shutdown retirement and producer/writer ordering and preserves partial received frames as failures.

PR36's initial d20b0d3 push session run42453964755 also retained a TRANSPORT_IO failure: the duplicate replay control reached its callback assertions before the final seq3 replay had forwarded. A deterministic real-engine hold reproduced that early terminal condition. The same43/89 control now additionally waits for the complete replay range and orderly LOGOUT, then checks final callback identities. All earlier assertions and timeout values remain intact; unexpected application I/O is still a failure.

The opt-in Phase 3C2 application path retains its protected-main integration record. Actual native D/8/F/9 bytes and validated FromApp callbacks bind to owned
schema9 evidence before the existing SQL financial authority applies them.
The separate live decoder preserves the old decoder's FIELD_ORDER negatives.

The continuation repaired replacement-acceptor readiness ordering and added
explicit retirement of old physical sockets before draining reconnect writes.
Interrupted admin bytes are retained separately from forwarded bytes; unexpected
I/O and application bytes from a retired socket remain unresolved. Shutdown also
settles startup, send and reconnect callers before STOP and rejects command admission
that resumes after stopping. Accepted same-order work waits for outstanding callbacks
without blocking their processing, then applies in retained observation order. The mandatory live matrix is now 118 controls, retaining
all 108 previously qualified controls and adding ten normal-shutdown, producer/writer and EOF regressions. The preceding108 included five native/socket, seven lifecycle, two same-order duplex and five host filesystem additions to the original89. Exact source, complete qualification, first failures,
review disposition and CI receipts are recorded in PR #35. See the
[live application guide](FIX44_LIVE.md) for recovery and profile limits.

The public application remains separately pinned to b021602. These local source
capabilities do not activate hosted FIX, migrate a hosted database or establish
external delivery/completeness. Phase 4 remains unfinished. Historical milestones
retain their own exact source and counts.

## Accepted protocol implementation checkpoint

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

### Public demo: released institutional workflow

The [public workstation](https://tradeflow.farhan-shafee.com) now includes isolated equities books plus fictional bond analytics, a server-owned private visitor workspace, dealer RFQ/exact quotation acceptance, simulated acknowledgments/fills/cancellations, immutable execution-derived cash/positions and historical reconciliation. App deployment `8d174084-7f30-40cb-a026-fa90f231c4a0` reached SUCCESS on November 6 at 08:49:00 EST.

The app uses dedicated private PostgreSQL, restricted roles, strict CA/hostname TLS and a persistent volume. Access still ends with the original session, logout or app restart; retention is separate. There is no public capability recovery. The former October 25 `265c9e0` equities release is preserved as rollback history.

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
| Phase 3C1 local session runtime                       | [Runtime guide](FIX44_RUNTIME.md), selected pinned peers, matching-response guard and supported retained-store restart      |
| Phase 3C2 local financial ingress                     | [Live application](FIX44_LIVE.md), actual raw/callback evidence and opt-in schema9 atomic financial handoff                 |

The local FIX application SDK is explicitly server-side and opt-in. The offline session checker does not call it, open a connection or persist session state. Synthetic CompIDs are correlation labels, not authentication. A corpus command succeeds when literal expected reports match, including expected INVALID, INCOMPLETE and OUT_OF_SCOPE cases; not every transcript is conformant.

## Remaining boundaries

The 3C0 checker remains offline. The selected local 3C1 runtime and 3C2 financial
ingress add separately bounded session/recovery/application capabilities. They do
not establish arbitrary crash durability, full FIX certification, external peer
interoperability, verified external delivery or external completeness. Phase 4
remains unfinished and requires its own implementation and qualification.
No hosted FIX rollout follows from these local source milestones.

All credentials, quotes, orders and executions are synthetic. There is no real venue/dealer connectivity, live market feed, settlement, real-money P&L, production identity/tenant assurance or regulated-trading claim.

## Reproduce and inspect

Start with the [README](../README.md), [test strategy](TEST_STRATEGY.md), [CI gates](CI_CD.md), [fixtures](FIXTURES.md) and [public equities/interview walkthrough](INTERVIEW_DEMO.md). Historical [productization](PRODUCTIZATION.md), [validation](VALIDATION.md), [audit](AUDIT.md) and [delivery](DELIVERY_REPORT.md) retain their original context.

Counts, screenshots and reports belong to their named source/environment. Older captures show the equities slice. CI artifacts expire; source/run/job references retain the revision context. Broader security, availability, performance and peer-interoperability claims require separate evidence.

## Accepted interview rehearsal — November 5

The owner approved PR #31, merged as GitHub-verified `939a81b7bbd44c5485224c60c15a1988ffb3f383` with tree `70822ae32d252f036a196a6ead5cda0c1c6a6d0a`. [Main quality](https://github.com/farhan-shafee/institutional-trading-sdet-lab/actions/runs/42146377202) and [main persistence](https://github.com/farhan-shafee/institutional-trading-sdet-lab/actions/runs/42146377266) passed all eight mandatory jobs on first attempts. Both PostgreSQL executions passed 455/455, preserving 247 executions and 44 rotations; all measured workload phases stayed below 30 seconds. The public application was not deployed by that merge.

The accepted rehearsal includes [reproducible setup](INTERVIEW_SETUP.md), [30-second/three-/five-/ten-minute scripts](INTERVIEW_DEMO.md), [source/test requirement mapping](TRADEWEB_SDET_MATRIX.md), [independent-explanation study material](INTERVIEW_STUDY_GUIDE.md) and a bounded owned-database journey. Its exact evidence is retained in PR #31; full human-paced narration and independent mastery remain personal rehearsal requirements.

## Accepted public institutional workflow - November 6

The [public profile contract](PUBLIC_WORKFLOW.md) was accepted in PR #32 and deployed after exact-source qualification and all eight main checks. It is a distinct hosted activation; local PostgreSQL activation still defaults OFF. The eight base migrations, financial rules, SQL/lock/transaction limits and offline FIX contracts remain unchanged.

The reviewed public policy allows workspace writes for 30 minutes and cleanup eligibility after 60 minutes. Access is limited to the original synthetic session (at most 30 minutes from login), logout or app restart; starting later does not extend authentication. Cleanup preserves protected leases and can be delayed by infrastructure failure. Native durable recovery is unavailable publicly. Local seven-day/thirty-day ownership is unchanged.

The receipt distinguishes qualification, actual three-browser main-domain acceptance, database restart, runtime TLS, monitor deployment and scheduled execution. Finite synthetic checks do not establish uptime, sustained capacity, real peer interoperability or the cause of historical intermittent failures.
