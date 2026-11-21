# TradeFlow Public Release and Phase 4 Exposure Design

Status: owner approved repository implementation and local/CI qualification on November 10, 2026. Implementation is in progress. Hosted preview resources and production cutover still require separate authorization.

## Purpose and decision

Complete delivery of the agreed synthetic institutional workflow by making the accepted Phase 4 financial capabilities usable from the public workstation, while retaining native FIX sessions and their financial handoff as explicitly local/CI capabilities.

The recommended next scope is an interactive public synthetic Phase 4 workstation, built on the existing TypeScript, semantic HTML, native Node HTTP server and PostgreSQL architecture. The proposed public exposure is new work: PR #38 accepted the finite financial models and their local/CI implementation, not a hosted writer profile or public UI.

Owner approval of this design would authorize repository implementation and local/CI qualification of that proposed public scope. Hosted resource provisioning, production database changes and public cutover remain separate review decisions after an exact candidate, preview and rollback evidence exist. No hosted resource is created by this design task.

## Verified starting point

| Surface                       | Observed state                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Protected main                | `29dd958f7f42a15841496a23ccfe594bfb864272`, reviewed tree `2fb60dd7e5e6f9c1785bc413965011a856839fd6`                            |
| Final source qualification    | PR #38 accepted R1–R3, merged normally; all 14 main jobs passed on attempt 1                                                    |
| Public app                    | `b0216022cb8ff18de904efea9279c91b3977d55f`, deployment `8d174084-7f30-40cb-a026-fa90f231c4a0`, SUCCESS                          |
| Existing public topology      | Cloudflare HTTPS → existing cloudflared service → private Railway Node app → private PostgreSQL over verified TLS               |
| Current app budget            | 0.5 CPU, 500000000 bytes memory, one replica; no increase is proposed                                                           |
| Current provider state        | App has no staged changes; exact source pin remains b021602                                                                     |
| Public functionality          | Equities, two coupon-bond analytics, private visitor RFQ/execution/ledger/reconciliation workflow                               |
| Newer functionality           | Local FIX peers and financial handoff; zero analytics, curves, portfolio risk, corrections, gross settlement and exact FIFO/P&L |
| Current post-trade activation | Explicit owned loopback schema-10 startup only; ordinary/hosted startup does not select it                                      |

The historical capacity financial finding remains `UNRESOLVED_NOT_REPRODUCED`, root cause `UNKNOWN`. The owner accepted that unresolved risk for the synthetic local/CI lab. Green qualification and the controlled capture demonstration do not explain it. That acceptance is not a public-release waiver.

## Approaches considered

| Approach                                                   | Delivery and tradeoff                                                                                                                            | Disposition                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Refresh the existing public release and link local reports | Lowest implementation cost; exposes newer stateless APIs if selected, but visitors still cannot operate Phase 4                                  | Valid smaller release, insufficient for the proposed interactive public target |
| Interactive synthetic Phase 4 public workstation           | Visitors can follow the full financial workflow; requires a new hosted profile, UI, cross-session controls, qualification and controlled release | Recommended proposal                                                           |
| Host native FIX engines alongside the public app           | Adds an operational service and exposure surface, exceeds the existing small-app operating assumptions and the approved local FIX boundary       | Excluded from this release                                                     |

The recommendation is the assistant's design choice for owner review, not a previously approved expansion. Existing financial contracts, instrument eligibility and numerical conventions remain the source of truth.

## User-visible scope

Preserve the existing four primary tabs and equity behavior. Extend the existing analytics and dealer-workstation disclosures rather than replacing navigation or introducing another frontend framework.

| Capability            | Public surface and behavior                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Additional instrument | Add the approved zero-coupon analytics option; label it analytics-only and keep it ineligible for RFQ/order entry                                    |
| Curves and spreads    | Named immutable curve fixture, economic as-of date, curve valuation and continuous z-spread views; no editable market feed or new curve construction |
| Portfolio risk        | Signed PV, parallel DV01, four key-rate dollar sensitivities and the approved stress scenarios                                                       |
| Corrections and busts | Original versus adjusted execution detail, expected revision, price-only correction and terminal full bust                                           |
| Synthetic settlement  | Explicit paper-funding initialization, due/processing dates, available balances, unsettled obligations and FAILED/SETTLED/REVERSED/VOIDED history    |
| FIFO and P&L          | Exact-model results displayed at declared scales, realized/unrealized/total P&L, remaining basis and equity bridge                                   |
| History and recovery  | Immutable command outcomes, bounded audit/history pages and original-request recovery after an uncertain response                                    |
| Native FIX evidence   | Revision-bound local/CI capability summary and verification links; no remote engine controls or public socket/session service                        |

Dates are labelled as simulated economic dates or actual recorded UTC. Source sequence, revision and valuation date remain distinct. Detailed provenance belongs in an expandable audit view; credentials, descriptor paths and schema/install details do not enter the visitor flow.

The trader explicitly initializes paper funding; the UI never presents it as a deposit. An uninitialized viewer workspace stays visibly uninitialized. A viewer may inspect their own permitted data but cannot initialize, register, correct, bust, settle or reverse. No cross-visitor sharing is introduced.

The reproducible walkthrough uses simulated start date 2030-01-15, with the existing exclusive next-coupon boundary. Other supported dates remain governed by the accepted contract; actual wall-clock UTC is never substituted for an economic date.

## Financial contracts retained

Use the original two tradable coupon-bond profiles, at most eight complete execution roots, at most two price corrections and a terminal full bust per root. The additional zero is analytics-only. Retain the fixed coupon-period window, approved curve fixtures, exact cash rounding, exact rational FIFO allocations and all unsupported-product boundaries.

Retain the aggregate 512-command/1024-event ceilings, existing FIX reservations and the exact 97-command/161-event post-trade allocation. No new durable arbitrary assessments or uncounted public writes are allowed.

Retain the three accepted rules:

1. Every admitted processing attempt, including FAILED, advances or preserves the processing-date watermark; reversals cannot precede their posting.
2. Available balances follow the recorded post-trade source sequence, independently of mark date and actual UTC.
3. Admitted FAILED settlements have immutable recoverable receipts. Pre-admission rejections consume no financial key.

The browser displays server-validated financial responses; it does not calculate authoritative cash, settlement, FIFO or risk. Missing/incoherent source or marks remain UNAVAILABLE, never a fabricated zero. Original financial kernels, migration bytes, immutable execution/order/FIX history and independent oracles remain preserved.

## Hosted ownership and API boundary

Reuse the existing public session and server-owned workspace binding. One exact allocation intent belongs to one authenticated synthetic session. Proofs, read/trade capabilities and ownership material stay server-side. The browser retains only permitted session credentials and bounded original request intent/keys, following existing behavior.

Preserve original-session access expiry, logout/restart revocation, 30-minute workspace write lifetime, 60-minute cleanup eligibility, 50 retained-workspace ceiling and protected-lease cleanup rules. Starting a workspace does not extend login life. Native create/recover/rotate endpoints remain unavailable publicly.

Public Phase 4 operations use strict versioned request/response schemas and the existing session-bound sandbox adapter. The server resolves the current owned sandbox, scope, generation and actor before calling the financial service. A caller cannot supply a foreign proof, actor, position book, funding amount, instrument terms or another visitor's ownership.

Reauthorization precedes immutable receipt reads/replay and final COMMIT. Viewer, revoked, expired, logged-out and cross-session denials are required at the wire and SQL boundaries. Session changes invalidate pending UI publication; stale responses cannot populate a replacement workspace.

An admitted failure's HTTP 409 typed financial body is rendered as a retained outcome, separately from an ordinary rejection. A retained original key replays the original outcome. A new failed-settlement attempt is an explicit user action within the original lifetime budget. An OUTCOME_UNKNOWN result retains the original payload/key and offers original-request recovery; it never silently creates a replacement financial operation.

## Database and compatibility design

The current public profile is `public-workflow-v1`, with verified profile checksum and the eight base migrations. `PostTradeWorkflowDatabase` requires a loopback tf_app URL and an owned local/CI database name. The current post-trade installer verifies a private owner descriptor/nonce and installs exact migrations 009 and 010 after the base set. It must not be pointed at Railway or weakened to accept a hosted URL.

Implement a separate explicitly versioned public post-trade profile and hosted database admission path. Reuse the existing private-network hostname, CA/hostname TLS verification and distinct application/reconciler/maintenance/migrator role separation. Runtime cannot migrate or assume owner privileges. Existing local-only and public-v1 profiles retain their admission rules.

The builder owns the exact class/module names and versioned public route naming. The implementation must define those wire contracts before adding handlers, preserving existing route/status/body contracts.

Qualification must demonstrate the exact 001–010 dependency/grant set, forced RLS, correct database identity, least-privilege RPC access, public profile checksum and schema/source compatibility. Include migration 009 dependencies even though no native FIX engine runs in hosting. Financial migrations remain byte-identical; hosted admission/role/profile changes are additive and separately reviewed.

Use a fresh isolated database for the proposed profile. Do not upgrade the existing production database in place for this release. The preview must prove cleanup of the complete public plus financial graph, reservations and key registry, including expiry while operations/leases exist. Retained original production data stays with the rollback database.

Database image assembly, checksum manifest, public-profile verifier, release configuration guard and compatibility tests must include the new explicit profile. No automatic acceptance of refreshed source pins, broad preservation ignores, dynamic schema fallback or bypass of the existing source-preservation chain is permitted. If new public wiring touches a pinned original source, exact additional source-admission changes require a separate reviewed disposition before native qualification.

## End-to-end acceptance example

Use two supported original execution roots with value date 2030-01-15: BUY par100 and SELL par40. Register both; price-correct their dirty consideration to the approved literal example of USD100.88 and USD43.80 respectively. Apply only the unchanged approved price/accrual conventions.

1. Initialize the fixed window and USD100000000 paper funding.
2. Attempt the SELL settlement before securities are owned; retain one admitted FAILED receipt without balance posting.
3. Settle BUY and then SELL at a nondecreasing processing date. The expected available security position is par60.
4. At FLAT_V1 and economic as-of 2030-01-15, independently check remaining basis60.528, exact realized P&L3.448 and the approved curve valuation/equity example. Displayed total P&L is3.49 and equity100000003.49; the displayed component rounding delta is disclosed.
5. Reverse SELL then BUY, proving conservation and unchanged economic P&L while unsettled obligations return.
6. Exercise correction/bust and historical source cutoffs, preserving raw execution and original FAILED receipts.
7. Replay the retained failed key after funding changes and recover a genuinely uncertain original request without duplicate posting.

These are required future expected outcomes, not newly executed results. Additional cases cover both original conventions and BUY/SELL, partial lots/short covers, wrong dates/revisions, failed-reversal rejection, exhausted budgets, missing roots/marks, view-only roles, current authorization, concurrency, restart and full cleanup. The existing separate native FIX-to-finance-to-post-trade journey remains mandatory.

## Verification and readiness gates

| Gate                           | Required evidence                                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Existing behavior preservation | Exact old financial/migration/source identities, preserved tests and accepted phase ancestry; first failures remain recorded                                                                                       |
| Hosted profile                 | Actual dedicated TLS database image; owner/app/reconciler/maintenance separation; grants/RLS; source/profile mismatch rejection and compatibility negatives                                                        |
| API and accounting             | Independent wire schemas and SQL/Python reconstruction of cash/par/basis/equity; strict errors, receipts, idempotency and authorization                                                                            |
| Browser                        | Trader/viewer and cross-visitor paths in Chromium, Firefox and WebKit, baseline and repeat with original retry/deadline policy; selected 320px/mobile and keyboard inspection                                      |
| Lifecycle                      | Genuine before/after-COMMIT failures, original-key recovery, current session revocation, restart, retention and owned cleanup                                                                                      |
| Complete integrated source     | Locked dependencies/audits, type/lint/format/contracts/workflow, units, independent oracles, build/production smoke, two fresh original and owned PostgreSQL passes, workstation/public-image and all native gates |
| Independent and human review   | No unresolved Critical/Important implementation issue; explicit scope/model/known-risk dispositions bound to the final candidate                                                                                   |
| Preview operations             | Exact source/tree/CLEAN provenance, runtime roles/TLS, real-domain selected journey, cleanup and measured resource behavior inside current limits                                                                  |
| Rollback                       | Executed restore of the captured known-good release/configuration; retained-artifact restoration distinguished from a source rebuild                                                                               |

Do not increase limits, retries or deadlines to obtain a pass. A recurrence of the retained financial finding blocks progression and requires investigation from the actual captured evidence. A green rerun cannot close it.

## Delivery order

1. Review this proposed scope and its public-write/known-risk boundary.
2. Implement the additive hosted profile, strict API contracts and authorization/cleanup support; qualify it locally before frontend integration.
3. Extend the existing analytics and post-trade UI; qualify real browser/accounting journeys and retain the private native journey.
4. Consolidate README, CURRENT_STATE, setup/demo/recovery guides and a single exact-source release receipt; reconcile historical open PRs individually without blindly merging them.
5. Qualify one immutable integrated candidate and obtain model/security/test acceptance.
6. Prepare an isolated hosted preview with a fresh database under separately authorized resource scope; prove selected public behavior, resource limits and rollback.
7. Present the exact production change set and preview evidence for release approval. Apply only that accepted change set.
8. Verify main-domain runtime and selected financial/browser/security paths, then synchronize the portfolio with separate accepted-source and deployed-source claims.

Until step6 is authorized, no provider resources, variables, services, schemas or deployment pins are changed. Until step7 is accepted, the existing public app remains on b021602.

## Cutover and rollback

The next release's rollback baseline is the current institutional b021602 / 8d174084 release, not the older equities-only265c9e0 release. Capture the current app source/artifact, build/start settings and complete configuration in the existing private handling mechanism. No credential values enter the design, PR or public evidence.

Keep the existing public database/volume and tunnel intact. Build and qualify the candidate against its separate versioned database. Cutover changes only the reviewed app source/configuration and its new database targets, using one reviewed provider change set where supported. Verify terminal SUCCESS, exact source/tree and runtime ownership/TLS before real-domain acceptance.

Rollback restores b021602 with its captured configuration and original database target; the failed new database and evidence are retained for inspection. No destructive database downgrade, old-volume deletion, credential reuse across new roles, global cleanup or unrelated service change is a rollback shortcut.

Provider metadata currently says the known-good deployment can be redeployed/rolled back. The preview must still prove the actual available mechanism. If the provider rebuilds source instead of restoring the retained artifact, document and test that narrower guarantee.

## Explicit public-release decisions

Before implementation: owner accepts or revises the recommended interactive public Phase4 scope in this design. API/CLI-only Phase4 remains a valid engineering completion target if the owner selects the smaller release instead.

Before hosted work: approve the exact preview resources/configuration and measured operating budget. No new project, plan purchase or infrastructure increase is implicit.

Before production: accept the exact qualified candidate, selected exposure and preview/rollback result; resolve the historical financial finding or explicitly accept its unresolved status for the hosted synthetic demo. The existing local/CI acceptance does not provide that expanded risk disposition.

No live broker/exchange, external market feed, real funds, actual securities settlement, regulated certification, public FIX engine or enterprise HA is included. Optional instrument families, additional models and a new UI framework are not required for this release.

## Source references

- [Accepted PR38 and its main closeout](https://github.com/farhan-shafee/institutional-trading-sdet-lab/pull/38)
- [Recovered roadmap and final closeout criteria](https://github.com/farhan-shafee/institutional-trading-sdet-lab/blob/29dd958f7f42a15841496a23ccfe594bfb864272/docs/plans/PHASE3C.md#L263)
- [Finite approved financial scope](https://github.com/farhan-shafee/institutional-trading-sdet-lab/blob/29dd958f7f42a15841496a23ccfe594bfb864272/docs/PHASE4_COMPLETION_CONTRACT.md)
- [Private post-trade API/report boundary](https://github.com/farhan-shafee/institutional-trading-sdet-lab/blob/29dd958f7f42a15841496a23ccfe594bfb864272/docs/PHASE4_POSTTRADE.md)
- [Owned-only database admission](https://github.com/farhan-shafee/institutional-trading-sdet-lab/blob/29dd958f7f42a15841496a23ccfe594bfb864272/app/persistence/postgres/post-trade-workflow.ts)
- [Existing public ownership wrapper](https://github.com/farhan-shafee/institutional-trading-sdet-lab/blob/29dd958f7f42a15841496a23ccfe594bfb864272/app/server/public-demo/workspaces.ts)
- [Existing public profile and verified-TLS configuration](https://github.com/farhan-shafee/institutional-trading-sdet-lab/blob/29dd958f7f42a15841496a23ccfe594bfb864272/app/server/public-demo/configuration.ts)
- [Current production runbook](https://github.com/farhan-shafee/institutional-trading-sdet-lab/blob/29dd958f7f42a15841496a23ccfe594bfb864272/docs/RAILWAY_PRODUCTION.md)

The baseline and provider observations above were read on November10,2026. Subsequent source or provider changes require fresh binding before implementation/cutover. This document deliberately does not label proposed behavior, preview, migration, rollback or new acceptance cases as already executed.
