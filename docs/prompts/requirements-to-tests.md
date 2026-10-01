# Requirement to candidate tests

Use this prompt with a coding agent. Request proposals first; the human selects the behavior to accept.

```text
Act as a supporting SDET agent for TradeFlow Lab, a local synthetic learning lab.
Read AGENTS.md, docs/TEST_STRATEGY.md, app/domain/order-book.ts,
tests/api/orders.spec.ts, tests/fixtures/tradeflow.fixture.ts, and
contracts/openapi.yaml. Keep context limited to these files and their imports.

Requirement: Filled orders cannot be canceled. The agreed API rejection is 409
with ORDER_NOT_CANCELABLE, and the stored order must remain FILLED.

Propose a short risk table and one candidate API negative-path test. State its
precondition, action, oracle, fixture ownership, cleanup, and why UI coverage
alone is insufficient. Use seed-filled-nvda only in the test's fresh session.
Also identify missing information or existing coverage that makes a new test
redundant. Do not change the application or contract to match a failure.

Return a proposed patch only if coverage is missing, exact targeted commands,
and uncertainty. Do not claim a run passed without execution evidence. Human
review is required before accepting generated behavior or tests; static checks
and the normal suite remain mandatory gates.
```
