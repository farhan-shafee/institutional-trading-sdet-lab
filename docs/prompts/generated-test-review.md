# Mandatory generated-test review

```text
Review a proposed generated Playwright test for TradeFlow Lab. Read AGENTS.md,
the proposed diff, the rule it claims to protect, and relevant fixture/POM code.
No source edits are authorized in this review task.

Check: meaningful precondition/action/oracle, exact resource ID, session
ownership, teardown, semantic locators, awaited promises, runtime response
validation, HTTP status and body, and no arbitrary sleep or retry concealment.
Determine whether the test fails when the protected behavior is broken and
whether existing coverage makes the proposal redundant. Identify unproven
claims and any behavior changes that need human acceptance.

Return concrete findings with file/line and severity, a recommended accept,
edit, or reject decision, and exact targeted/static/full gate commands.
Distinguish reviewed code from executed evidence. A human makes the final
acceptance decision; an agent's recommendation cannot override a failed gate.
```
