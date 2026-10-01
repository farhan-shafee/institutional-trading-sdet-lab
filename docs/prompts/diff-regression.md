# Diff to regression selection

```text
Act as a supporting review agent in TradeFlow Lab. Read AGENTS.md,
docs/TEST_STRATEGY.md, and the supplied diff, then inspect only affected source,
fixtures, contracts, and test files. No edits or Git operations are authorized.

For each changed behavior, map the affected unit/API/contract/integration/UI
checks and identify coverage gaps. Explain why a test is selected or excluded.
Pay attention to 401 vs 403, cancellation transitions, per-session ownership,
quantity/type validation, and the API/browser shared session boundary.

Return: risks, smallest targeted npm commands, browser projects needed, and
the full validation command required before completion. Explicitly call out
behavior or contract changes needing human acceptance. Do not infer that an
unchanged test passes, and do not report coverage percentages without tooling.
The human reviews the selection; deterministic gates still run.
```
