# TradeFlow dependency maintenance - October 25, 2026

## Defect and compatible patch

A fresh locked install reproduced three affected packages in the full npm audit: two high and one moderate. The production-only audit identified one high package, Zod. This identifies known dependency findings, not observed exploitation or proof that every advisory is reachable through this application.

| Package  | Previous lock | Patched lock | Ownership                                                  |
| -------- | ------------- | ------------ | ---------------------------------------------------------- |
| Zod      | 4.6.5         | 4.6.7        | Direct runtime dependency; manifest floor raised to ^4.6.7 |
| Undici   | 8.11.2        | 8.12.3       | Development-only Swagger/OpenAPI reference-parser chain    |
| fast-uri | 3.1.8         | 3.1.9        | Development-only AJV chain                                 |

Only those three package entries and the root Zod requirement changed in the lockfile. Existing compatible parent ranges resolve the transitive patches; no forced major update, override or advisory suppression was used. A clean production-only installation must still contain only Zod.

The observed advisory set was:

- Zod: [oversized collection validation](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
- Undici: [EventSource parser memory](https://github.com/nodejs/undici/security/advisories/GHSA-4qv8-2p9j-2685), [integrity algorithm casing](https://github.com/advisories/GHSA-f72v-6w45-q472), and [excessive content encodings](https://github.com/advisories/GHSA-xjj6-f33q-929c).
- fast-uri: [encoded schemes](https://github.com/advisories/GHSA-w74x-v6f9-j3xg), [relative path normalization](https://github.com/advisories/GHSA-xhq7-xmqj-769h), [host canonicalization](https://github.com/advisories/GHSA-wjr9-j795-jxcr), and [suffix-reference colon handling](https://github.com/advisories/GHSA-333x-w4r6-6crp).

## Regression gates

The local validate command and hosted workflow require both full and production-only npm audits to succeed. Audit steps are unconditional and blocking; registry errors fail rather than silently becoming a clean result. The workflow validator checks both commands and rejects conditional or ignored audit failures.

Before adding the workflow steps, the updated validator failed with Missing CI gate: npm audit; adding the gates made it pass. Both patched-tree audits returned zero known findings on October 25. This result is dated and does not certify unknown vulnerabilities, platform dependencies or generalized security.

## Acceptance evidence

The fresh local acceptance run completed on October 25: type checking, lint, formatting, OpenAPI and workflow validation, **54 unit checks**, native production build and clean production-only smoke, then **211 normal Playwright executions** and **422 twice-repeated executions**. The two successful Playwright runs recorded zero failed, flaky or skipped results, with the original assertions, workers, retries and timeouts unchanged.

The first local full run was not green: one Firefox stale-creation/viewer-session case timed out waiting for five rows and reported zero; its captured snapshot showed the five rows. The original failure and artifacts were retained. Twenty isolated repetitions of that exact case passed before the fresh full/repeated runs. The cause of that one-off delay was not established; later passes do not erase the initial result or certify absence of intermittency.

A fresh read-only review found no Critical or Important issues in the patch and related public-content changes. Hosted Ubuntu [CI run 40214510996](https://github.com/farhan-shafee/institutional-trading-sdet-lab/actions/runs/40214510996) succeeded at `265c9e0ed1fdc528193cd474d966513decd03d3b` on October 25 at 2026-10-25T17:05:08Z. It passed both audits, 54 unit checks, the clean production-only installation/smoke and 211 Playwright executions. Windows local termination remains explicitly forced; Linux shutdown acceptance belongs to this hosted run. Do not infer rollout from a documentation push or a successful local build. Use [main CI](https://github.com/farhan-shafee/institutional-trading-sdet-lab/actions/workflows/quality.yml?query=branch%3Amain) for the exact source and [the production runbook](RAILWAY_PRODUCTION.md) for the current release.

Application behavior, synthetic contracts, test assertions, retry policy and timeouts are unchanged. The app still has no database or persistent volume. Replacing its process resets synthetic sessions/orders; the separate Cloudflare Tunnel remains the ingress.

## Observed production release

| Evidence                    | Observed result                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reviewed application source | `265c9e0ed1fdc528193cd474d966513decd03d3b`                                                                                                                   |
| Railway deployment          | `30ca206b-765b-4fe5-ad22-50a1f2d02aec`; SUCCESS at 2026-10-25T17:08:36.249Z                                                                                  |
| Public release checks       | 20/20 passed at 2026-10-25T17:09:14.687237+00:00                                                                                                             |
| Source configuration        | Only the existing production app commit pin changed                                                                                                          |
| Replicas                    | App and unchanged tunnel each online with one running and zero crashed replicas                                                                              |
| Public artifact identity    | Browser JavaScript, stylesheet, favicon and OpenAPI bytes match the local reviewed production build                                                          |
| Runtime workflow            | Own synthetic trader/viewer login, exact owned order read/create/cancel, cross-session denial and viewer mutation restriction; verification sessions revoked |
| Resource snapshot           | App RAM about 5.4% of its nonzero limit; tunnel about 12.8%; one-hour CPU/RAM current and averages below warning thresholds                                  |
| Bounded rollout logs        | Three app entries, zero tunnel entries, zero error markers through the initial acceptance review; not an ingress-metrics inference                           |

Railway retained the existing build/start/health configuration, capacity, private tunnel ingress and service identities. TradeFlow has no database or volume; the deployment reset ephemeral synthetic sessions/orders. The health monitor's latest reviewed result was valid with both public checks OK and backup not applicable. These are finite dated observations, not sustained availability, capacity, generalized security or recovery guarantees.

The source pin names the application patch. Later commits that record this release and synchronize public documentation are documentation-only; their publication does not silently replace the running application.

## Related public evidence synchronized

The [TradeFlow case study](https://farhan-shafee.com/work/tradeflow), Now page, llms.txt, deployment matrix, site README/interview briefing and [personal GitHub profile](https://github.com/farhan-shafee) now reflect this release. All tracked text references across the application, portfolio and profile were searched; generic architecture descriptions and dated historical receipts were retained where still accurate.

- Portfolio source: [9675cac](https://github.com/farhan-shafee/farhanshafee.com/commit/9675cacb77518e7cf8a0d7fa4f91d3d42f72d856).
- Portfolio [hosted CI 40215539145](https://github.com/farhan-shafee/farhanshafee.com/actions/runs/40215539145) passed 69 unit and 26 browser checks; downloaded full/production audit JSON files both contain zero findings.
- Portfolio Railway deployment a350a116-a6a6-4295-90eb-0c8b502cbb8c reached SUCCESS at 2026-10-25T17:20:08.381Z with that exact source.
- Twenty-two public portfolio content/indexing/asset/link checks passed at 2026-10-25T17:20:21.258520+00:00.
- Profile source: [4c9d129](https://github.com/farhan-shafee/farhan-shafee/commit/4c9d129294222904b822eb597909db400ec0c119); current main readback confirms the patch, CI and dated audit boundary.
- A later TradeFlow monitoring review at 2026-10-25T17:17:49.223Z again found zero bounded app/tunnel error entries. The post-release monitor result at 2026-10-25T17:17:25.000Z had both public checks OK and backup not applicable.

The documentation commit that records these results does not change application source or advance the running app beyond the reviewed patch. The saved completion report also closes the former three-package maintenance item while preserving unrelated project closeout boundaries.
