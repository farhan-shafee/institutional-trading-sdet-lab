# Public source admission implementation plan

Owner explicitly approved the exact18 replacement pairs in PUBLIC_POSTTRADE_SOURCE_ADMISSION.md on2026-11-11 for native qualification of PR39 source379af5cd99f8c519976e31dd4863cfbf8c264b6e. Design: docs/superpowers/specs/2026-11-10-tradeflow-release-exposure-design.md. No deployment, risk waiver or merge acceptance is implied.

## Review focus

Exact18 old/new pairs, immutable v1/v2/v3 chain,415 unchanged originals and19 combined replacements. Historical fixtures only exercise unchanged controls and never supply runtime/build source. All3 entrypoints freeze metadata, loaders, fixtures and tests before controls and verify after execution. Missing/extra paths, tamper, symlinks, skipped/expected-failure/incomplete controls fail closed. Original43/89,118 and additional1 matrices, assertions, budgets and deadlines remain intact.

## Tasks

### 1. Strict additive v4 contract and controls

Write failing loader/fixture/admission controls; implement fixed-digest metadata bound to379af5c and exact18 reviewed pairs. Preserve historical25 controls in isolated, exact-hash staging. Expected: typed complete v4 controls pass; any unapproved bytes or metadata are refused. Commit implementation after Task2 integration.

### 2. Native caller integration

Write failing real caller admission/freeze tests; switch all3 native hosts and direct posttrade admission to v4. Extend session input inventory and daemon-boundary fixture metadata without changing assertions or budgets. Expected: all new and unchanged historical/daemon controls pass. Run typecheck/lint/validate and repeated complete tests on pinned runtime, plus unchanged native gates on final published source.

### 3. Independent review and final qualification

Review this admission phase independently against379af5c; fix material findings RED→GREEN. Publish to existing draft PR39 using normal protection/lease. Fetch exact published commit into both workspaces, qualify original session43/89, application118 and posttrade1 plus final-head CI. Preserve first failures and exact provenance. Expected: complete receipts, honest unresolved financial risk and draft status; final human acceptance stays separate.
