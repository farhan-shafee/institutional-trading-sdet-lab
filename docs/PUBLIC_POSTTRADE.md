# Public post-trade operation and recovery

[PR #39](https://github.com/farhan-shafee/institutional-trading-sdet-lab/pull/39) was accepted, merged and separately approved for cutover. The [public workstation](https://tradeflow.farhan-shafee.com/) serves commit `20d59355285e14dc3985ee478559a6bb335db190` with the explicit `public-posttrade-v1` profile. See the [historical candidate receipt](PUBLIC_POSTTRADE_CANDIDATE.md), [accepted financial model](PHASE4_POSTTRADE.md) and [deployment and rollback runbook](RAILWAY_PRODUCTION.md).

## November 21 live verification

Railway deployment `5a0d66e1-66ac-4150-887f-5044a013ae40` reached SUCCESS at 15:51:40 UTC with tree `e3fa71fa5255bda3614e59520aa2d7ad58a75b4d`. The exact runtime used a fresh private PostgreSQL 17.10 database. All ten migration hashes, distinct restricted roles, forced post-trade RLS and TLS 1.3 passed verification. Negative probes rejected plaintext and a wrong hostname.

| Live check                  | Observed result                                                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Synthetic financial journey | Chromium 27.250 s, Firefox 27.627 s, WebKit 29.727 s against the unchanged 30 s deadline. The journey covered an admitted failed settlement, funded BUY/SELL settlement, exact P&L, reversal and full bust. |
| Analytics and accessibility | All three browsers passed zero-coupon and named-curve checks, including the 320 px layout and keyboard controls.                                                                                            |
| Authorization               | Synthetic viewer restrictions, cross-session refusal and disabled public native ownership routes passed.                                                                                                    |
| Original-key recovery       | The committed funding response was withheld from the browser. Reload recovered with the same key and the test workspace retained exactly one funding receipt and one funding event.                         |
| Reconciliation              | `COMPLETED_CLEAN`, zero findings, physical schema 10 and scope `RAW_WORKFLOW_BASE_8`.                                                                                                                       |

The checks used isolated synthetic workspaces with the normal retention policy. They establish the selected public paths at cutover. The owner accepted the still-unexplained historical capacity finding for this demo with rollback on recurrence or failed required verification. The old app release settings, old database/volume, and tunnel were retained. No recurrence was observed in the verified paths and reviewed logs.

## Activation and fresh database

Default startup and the original public-workflow-v1 profile retain their existing behavior. The new path requires both `TRADEFLOW_PUBLIC_DEMO=on` and `TRADEFLOW_PUBLIC_POSTTRADE=on`, hosted-demo mode, and all three private database targets plus the public CA. Partial/invalid configuration fails closed. Runtime uses separate app, reconciler and maintenance roles over verified CA/hostname TLS; no runtime role migrates.

Use a **fresh, dedicated** database assembled from `deployment/posttrade-postgres`. Its manifest includes byte-identical original migrations001–010 and the separate `db/public-posttrade/001_profile.sql`. Admission requires exact migration hashes, the original financial source, profile `public-posttrade-v1`, profile checksum, restricted RPCs and forced financial RLS. The private owned-only `PostTradeWorkflowDatabase` guard is preserved. The original private owned installer remains unchanged and is never a hosted migration tool. There is no additional manual migration entry point: use the fresh image and owned qualification harness.

The reconciler verifies the original RFQ/order/execution ledger scope (`RAW_WORKFLOW_BASE_8`) while explicitly reporting physical schema10 and all ten checksums. A clean reconciliation does not claim independent post-trade cash/FIFO/risk verification. Financial history, provenance and separate SQL/Python qualification supply those distinct checks.

Under separately authorized preview preparation, the existing private release journal tools generate distinct owner/app/migrator/reconciler/maintenance credentials and bind the public CA. Then seal a new explicit post-trade journal:

```sh
node --import tsx scripts/public-posttrade-release-config.ts /absolute/private/ca-bound.json /absolute/private/posttrade.json
```

This command is offline: it makes no provider call, preserves the original journal and refuses an existing output. The new envelope pins the profile checksum and new database image directory; its `applicationEnvironment` includes the explicit post-trade flag. It cannot be silently used as an original public-v1 journal. Treat both files as private credentials. Preview preparation must separately bind the exact reviewed commit/tree and prove the actual database/image identity; an offline journal is not deployment evidence.

## Reproducible financial walkthrough

Sign in as the synthetic trader and start a private workspace. Expand Dealer RFQ workstation, then Paper funding and post-trade. All economic dates below are simulated; recorded timestamps remain actual server UTC.

1. Explicitly initialize USD100,000,000 paper funding with start2030-01-15. Viewer workspaces remain uninitialized/read-only.
2. Use the original Treasury RFQ, quote acceptance, acknowledgment and execution controls to create BUY par100 and SELL par40, both agreed2030-01-15.
3. Register each execution. Correct BUY clean quote to100.880000000000 and SELL to109.500000000000; original par, side, date, quote and consideration remain inspectable. Adjusted considerations are100.88 and43.80.
4. Attempt SELL before owning securities. Its admitted FAILED409 has an immutable recoverable receipt and no balance posting. Settle BUY then SELL with nondecreasing weekday processing dates inside the fixed window.
5. Select FLAT_V1 and as-of2030-01-15. Available Treasury par is60, cash99999942.92, exact remaining basis60.528 and exact realized P&L3.448. Displayed total P&L is3.49 and equity100000003.49. The server discloses component rounding delta.
6. Reverse SELL then BUY at a date no earlier than posting. Funding/securities availability is restored; economic P&L is unchanged. Bust both roots after reversal; economic P&L then becomes a verified zero. Inspect original/adjusted history, failed receipt and bounded audit pages.

The eight-root/two-correction/full-bust model,97-command/161-event allocation, aggregate512/1024 ceilings and FIX reservations are unchanged. No income/redemption/fees/borrowing/FX/netting or real securities settlement is added. Zero-coupon analytics remains ineligible for RFQ. Curves are named synthetic fixtures, not live market data.

## Outcome and recovery semantics

| Observed outcome                                   | Meaning and next action                                                                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Typed admitted FAILED409                           | A durable failed settlement outcome exists. Inspect/replay that same key to recover its exact failure. An explicit new attempt uses a new key within unchanged lifetime bounds |
| Ordinary pre-admission rejection                   | No financial key or posting was consumed. Correct the input/state and make an explicit new attempt                                                                             |
| Network loss, malformed success or OUTCOME_UNKNOWN | Preserve the original key, operation and payload. Balances show UNCONFIRMED; risk/P&L is UNAVAILABLE until the original outcome is recovered                                   |
| Storage failure before request retention           | Refuse the write before network submission; do not invent a replacement intent                                                                                                 |
| Malformed retained bytes                           | Preserve them and block replacement writes; do not silently clear/rekey                                                                                                        |

The browser retains one bounded original financial intent per workspace before sending it. Recovery replays the exact original request or inspects an exact matching immutable receipt; it never guesses a new key. Unresolved RFQ/execution intent also prevents new financial mutations and current-balance claims. Completed financial receipts remain inspectable separately from the retained in-flight intent.

All reads/replays require current authorization. Logout, original login expiry or app restart ends public access; a new login cannot recover the former workspace. Starting later does not extend login expiry. This session-local command recovery is not cross-session durable ownership recovery. Native create/recover/rotate routes remain404 in the public profile.

Historical source cutoffs disable new financial commands. Balances follow the recorded post-trade sequence; valuation date and processing watermark are separate. Responses must match the requested workspace/source/curve/date before display. Missing/incoherent assessments remain UNAVAILABLE, without fabricated zero balances or risk.

## Qualification and release boundaries

```sh
npm ci
node --import tsx scripts/check-public-posttrade-profile.ts
npm run test:public-posttrade
```

The full gate requires Linux/WSL, pinned Node24.18.0, Python, Docker and the configured three Playwright engines. It builds the actual TLS PostgreSQL image and exact published native application, runs API/database tests plus baseline/repeated browser journeys, validates role/identity refusal and removes only proven owned test resources. It retains source-bound private receipts. Targeted `--verify-db` / `--verify-ui` modes are development evidence, not the full native-application gate.

Workspaces retain the original30-minute write/60-minute cleanup-eligibility policy and50-workspace ceiling. Protected leases and infrastructure failure can delay cleanup. Full financial graphs, command-key registry and reservations must be removed before retained capacity returns to zero. WSL test-port allocation checks Windows and Linux binding; limits/retries/deadlines remain unchanged.

Future preview resources and release changes require separate authorization. If the historical finding recurs or required release verification fails, preserve the evidence and follow the [rollback runbook](RAILWAY_PRODUCTION.md#release-acceptance-and-rollback).
