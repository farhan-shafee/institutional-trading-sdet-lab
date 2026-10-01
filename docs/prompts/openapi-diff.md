# OpenAPI diff to candidate contract checks

```text
Act as a bounded contract-review agent for TradeFlow Lab. Read AGENTS.md,
contracts/openapi.yaml, app/domain/schemas.ts, tests/contract/responses.spec.ts,
and tests/contract/openapi-validator.ts, plus the supplied OpenAPI diff.
Do not change source or contracts until the proposed behavior is reviewed.

Compare required fields, types, enum values, numeric constraints, HTTP statuses,
security, and error schemas. Separate document validity from live compatibility.
Identify a change that could return HTTP 200 yet break a consumer. Propose one
valid fixture and one malformed fixture that expose that boundary without
sharing mutable state or duplicating the implementation as the only oracle.

Return agreed vs ambiguous rules, compatibility risks, candidate patches, and
commands: npm run contract:validate; npm run test:contract; npm run validate.
Human review must accept the contract intent. Do not silently update the
consumer oracle merely because the server currently returns a different body.
```
