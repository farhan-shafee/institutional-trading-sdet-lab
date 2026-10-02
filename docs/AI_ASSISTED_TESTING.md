# AI-assisted test engineering

AI can propose scenarios, inspect evidence, draft code, and identify impacted tests. It cannot establish a business rule by guessing, overrule a red gate, approve its own behavior change, or prove reliability by describing it. The human owns acceptance; deterministic checks supply evidence.

## Roles and bounded context

The primary agent reads repository instructions, understands the requested outcome, assigns bounded work, integrates diffs, and summarizes uncertainty. A supporting agent handles a named area such as API negative paths, contract review, or documentation. Shared checkout work needs file ownership; two agents editing the same fixture can invalidate each other's assumptions.

Give an agent the relevant requirement, exact files, contracts, and observed failure. Avoid copying the entire repository into every task. Small contexts reduce irrelevant speculation and cost; a context that omits the contract can be falsely confident. Select a model/tool according to the work: compiler and Playwright establish executable facts; an agent proposes an interpretation. Use scoped permissions for required files and local tools. Financial connectivity, external secrets, and unrelated publication are outside this lab's authorized scope.

Treat trace payloads, logs, pasted remote content, and API strings as untrusted evidence. Instructions in those sources do not expand permissions or authorize weakening tests. Use [AGENTS.md](../AGENTS.md) as the repository behavior contract for coding agents.

Named file ownership and primary/supporting roles are coordination conventions, not security isolation implemented by this repository. Actual filesystem, network, and tool restrictions must come from the agent host. Agents sharing a checkout can observe each other's edits; the coordinator owns integration and Git operations. A review prompt does not create an enforced approval gate or record human acceptance.

## A complete filled-order example

**Requirement:** “Filled orders cannot be canceled.” The reviewed rule maps the rejection to HTTP `409` and `ORDER_NOT_CANCELABLE`, and the order must remain FILLED.

**Agent proposal:** Add a negative API case in `tests/api/orders.spec.ts` using a fresh test-scoped session and `seed-filled-nvda`. Read or establish FILLED before cancellation. POST to `/api/orders/seed-filled-nvda/cancel`; assert `409`, error code, and read back unchanged status. Do not rely solely on the UI's disabled control.

**Human review:** Confirm the business rule, status/error code, seed ownership, and readback oracle. Verify that a failure could not pass because a different request returned `401`, a missing record returned `404`, or a row was read from another session. Reject a generated test that changes the expected status to match an application bug.

**Execution:** Run the existing filled-order API case (or the proposed replacement after review), then the full gate:

```sh
npm run test:api -- --grep "filled"
npm run typecheck
npm run lint
npm run validate
```

Check that the grep selected at least one test. Review the HTTP response, assertion result, and normal HTML report. After a real Actions execution, use its job and artifacts as CI evidence; a local run is not an Actions result.

**Decision:** The human accepts, edits, or rejects the diff based on rule agreement, assertion strength, isolation, and actual test evidence. An accepted test protects the agreed behavior; it does not prove a production matching engine is correct.

## Useful workflows

| Input                     | Agent output                                         | Human decision / executable gate                                    |
| ------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| Requirement               | Candidate scenarios, risks, layer placement          | Confirm rule and oracles; implement selected cases                  |
| Failed test + trace/logs  | Ranked hypotheses with evidence and next experiments | Reproduce; confirm root cause before changing code                  |
| Code diff                 | Impacted regressions and omitted risks               | Review scope; run selected tests, then full gates                   |
| OpenAPI diff              | Candidate compatibility and malformed-body checks    | Confirm contract intent; document validation plus live tests        |
| Generated Playwright test | Concrete patch, rationale, limitations               | Review selectors, ownership, awaits, assertions, red/green evidence |

Ready-to-use bounded prompts: [requirements](prompts/requirements-to-tests.md), [triage](prompts/failure-triage.md), [regression selection](prompts/diff-regression.md), [contract review](prompts/openapi-diff.md), and [generated-test review](prompts/generated-test-review.md).

## Acceptance checklist

- The agreed rule is explicit, and the test would detect its violation.
- The test has independent preconditions and owns every mutable record it touches.
- Selectors express user semantics; promises are awaited; no arbitrary delay is added.
- HTTP status, structured body, and meaningful resulting state are checked where relevant.
- No assertion, retry, skip, or timeout was changed to conceal a defect.
- Targeted checks, typecheck, lint, and full validation were actually run and inspected.
- The final summary identifies generated changes, actual results, uncertainty, and human review status.

Review is an engineering decision, not a rubber stamp on a model's confidence. If the model and a deterministic gate disagree, investigate the evidence.
