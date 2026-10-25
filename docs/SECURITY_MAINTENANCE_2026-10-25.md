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

A fresh read-only review found no Critical or Important issues in the patch and related public-content changes. Hosted CI and the actual pinned production release are recorded after their workflow and provider deployments complete. Do not infer rollout from a documentation push or a successful local build. Use [main CI](https://github.com/farhan-shafee/institutional-trading-sdet-lab/actions/workflows/quality.yml?query=branch%3Amain) for the exact source and [the production runbook](RAILWAY_PRODUCTION.md) for the current release.

Application behavior, synthetic contracts, test assertions, retry policy and timeouts are unchanged. The app still has no database or persistent volume. Replacing its process resets synthetic sessions/orders; the separate Cloudflare Tunnel remains the ingress.
