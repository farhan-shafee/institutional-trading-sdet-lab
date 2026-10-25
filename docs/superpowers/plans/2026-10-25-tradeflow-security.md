# TradeFlow dependency maintenance implementation plan

> **For agentic workers:** Use superpowers:executing-plans for this authorized maintenance task. Track each step and verify the final diff with one fresh reviewer.

**Goal:** Close the observed TradeFlow dependency findings, release the patch and synchronize the related public documentation, portfolio and GitHub profile.

**Architecture:** Preserve the native Node.js application, synthetic contracts, session ownership and Cloudflare Tunnel topology. Apply compatible dependency updates and enforce full and production npm audits locally and in CI. Advance only the existing production app pin after validation.

**Tech Stack:** Node 24, npm, TypeScript, Zod, Playwright, Railway and the existing Next.js portfolio.

**Spec:** User request: "fix tradeflow and update anything related to it ... site or personal github"; the fresh October 25 full/production npm audits identify the concrete defects.

## Global constraints

- Synthetic data only; no financial integrations, database, persistent state or credential disclosure.
- Preserve server behavior, assertions, retries, timeouts, tunnel, DNS and other services.
- No forced dependency upgrades, audit exclusions or force pushes.
- Keep historical evidence dated; release and CI claims require observed terminal results.
- Existing publication and release are authorized by this request; no unrelated cleanup or migration.

## Review focus

- Clean production-only installs must contain the patched runtime dependency without development tooling.
- Missing or conditional audit gates must not pass workflow validation.
- Runtime/OpenAPI, viewer permissions and session isolation must retain their observable behavior.
- Production must execute the reviewed patch rather than remain on the previous pinned source.
- Public portfolio/profile claims must distinguish a dated zero-finding audit from a security guarantee.

## Task 1: Dependency patch and regression gates

Files: package.json, package-lock.json, .github/workflows/quality.yml, scripts/validate-workflow.ts, README.md, docs/CI_CD.md, docs/TEST_STRATEGY.md and docs/SECURITY_MAINTENANCE_2026-10-25.md.
Produces: a reviewed compatible patch and a passing local/hosted validation receipt.

- [x] Capture failing full and production audits and dependency paths.
- [x] Require both audit commands in workflow validation; observe the missing-gate failure.
- [x] Add unconditional CI audits and local validate audits.
- [x] Update Zod to ^4.6.7 and refresh only Zod, Undici and fast-uri within compatible ranges.
- [x] Inspect the lockfile diff; require full and production audits with zero findings.
- [x] Run typecheck, lint, validate and the twice-repeated normal suite without weakening checks.
- [ ] Document exact versions and bounded evidence; obtain one fresh review and publish a guarded commit.

## Task 2: Existing production release

Consumes: Task 1's reviewed source SHA and successful CI.
Files: current production runbook and a dated release receipt.

- [ ] Verify no unrelated staged Railway changes.
- [ ] Stage and accept only the original production app's new source pin.
- [ ] Observe terminal SUCCESS at the exact patch SHA.
- [ ] Verify public site/health, same-origin assets, synthetic role/session workflows and bounded app/tunnel logs.
- [ ] Record source, deployment, timestamps and finite acceptance results.

## Task 3: Public evidence synchronization

Consumes: the reviewed patch versions, actual CI and production receipts.
Files: portfolio TradeFlow data/evidence, deployment matrix, relevant current docs, llms.txt, now page and the personal GitHub README.

- [ ] Search every tracked TradeFlow reference; update current claims and retain dated history.
- [ ] Run portfolio formatting, lint, types, units, build, browser checks and full/production audits.
- [ ] Publish guarded portfolio/profile commits and verify actual CI, Railway deployment and served content.
- [ ] Update the existing documentation-sync report with the closed TradeFlow finding and linked proof.
