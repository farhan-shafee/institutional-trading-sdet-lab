# API and contract testing

The API is local and synthetic. Every protected request identifies a session by `Authorization: Bearer <token>`. Its book is owned by that token. `tests/api/` uses Playwright's [APIRequestContext](https://playwright.dev/docs/api-testing), while `tests/contract/` checks runtime response shape as a separate concern.

## Wire behavior

| Endpoint                      | Success                                  | Important boundaries                                 |
| ----------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| `GET /health`                 | `200`, status/service/synthetic metadata | Public readiness check                               |
| `POST /api/session`           | `200`, token and user role               | Invalid payload `400`; bad credentials `401`         |
| `GET /api/session`            | `200`, `{ user: ... }`                   | Protected; restores identity after browser reload    |
| `DELETE /api/session`         | `204`, no body                           | Missing/invalid token `401`; revokes the token       |
| `GET /api/orders`             | `200`, `{ orders: [...] }`               | Protected; symbol/side/status filters                |
| `GET /api/orders/:id`         | `200`, `{ order: ... }`                  | Unknown or another session's order `404`             |
| `POST /api/orders`            | `201`, `{ order: ... }`                  | Invalid inputs `400`; viewer `403`                   |
| `POST /api/orders/:id/cancel` | `200`, updated order                     | Unknown `404`; ineligible status `409`; viewer `403` |
| `GET /api/positions`          | `200`, `{ positions: [...] }`            | Protected static synthetic positions                 |

Protected routes return `401` for absent or invalid tokens. Errors have `{ "error": { "code": "...", "message": "..." } }`. Tests assert the intended status and code; a failure with the wrong reason is still a regression. JSON body endpoints also reject unsupported content type with `415` and bodies over 16 KiB with `413`. `GET /openapi.yaml` serves the public specification. OpenAPI is the detailed source for documented schemas and statuses.

Order detail and cancellation percent-decode the captured order ID once. For example, `%73eed-new-aapl` identifies the same order as `seed-new-aapl`. Malformed percent encoding returns `400 VALIDATION_ERROR`; a validly encoded ID absent from the authenticated session's book returns `404 ORDER_NOT_FOUND`.

## Valid input and status transitions

Order input has `symbol`, `side`, `quantity`, and `type`. Allowed symbols are AAPL/MSFT/NVDA/SPY; side is BUY/SELL; type is MARKET/LIMIT. Quantity is an integer from 1 through 1,000,000. LIMIT requires a positive finite `limitPrice`; MARKET rejects price. The API repeats validation regardless of browser form controls.

NEW and PARTIALLY_FILLED can transition to CANCELED. FILLED, CANCELED, and REJECTED cannot. Tests establish the initial status, send cancellation, inspect status/body, and read back state where it proves the rule. Missing required fields, unknown enum values, zero/negative/fractional quantities, and unauthorized callers belong primarily at this layer.

## Three distinct checks

1. **Document validation:** `npm run contract:validate` checks that `contracts/openapi.yaml` is a valid OpenAPI document. A valid document can still describe the wrong application.
2. **Runtime schema validation:** live response bodies are parsed by Zod. TypeScript's compile-time types disappear at runtime, so unchecked `response.json() as Order` is insufficient.
3. **Independent wire validation:** `tests/contract/openapi-validator.ts` fetches the live `/openapi.yaml`, resolves the operation/status response schema, normalizes OpenAPI 3.0 bounds and nullable syntax for JSON Schema, and uses AJV plus formats to check bodies independently of application TypeScript types and Zod definitions. This reduces the chance that producer and consumer share the same mistaken assumption. The helper is scoped to the constructs used here; it is not a universal OpenAPI compatibility engine.

The contract is OpenAPI 3.0; consult the [OpenAPI 3.0.3 specification](https://spec.openapis.org/oas/v3.0.3.html) when changing response schemas. Keep required fields, enums, integer constraints, and error cases aligned with behavior.

## HTTP 200 can be wrong

`tests/contract/responses.spec.ts` starts with valid live HTTP 200 bodies, introduces literal payload faults, and expects both validators to reject them. `tests/integration/contract-boundary.spec.ts` separately intercepts an actual browser response with HTTP 200 and malformed quantity, then checks validator rejection and the UI's contract error. `tests/failure-demo/contract-evidence.spec.ts` makes the same boundary visibly fail with a deliberately wrong AJV expectation.

```sh
npm run test:contract
npm run demo:contract
npm run report:demo
```

The normal contract and integration suites should exit `0`: the integration regression intercepts a malformed response and asserts that the validators and UI reject it. The demonstration intentionally exits `1` because it makes a deliberately wrong assertion; inspect the schema issue and intercepted response in its trace. Both interceptions are scoped to their test's browser context and require no server edit. The deliberately failing expectation remains confined to the explicit demo. A wire schema proves shape, not financial correctness: a well-formed FILLED order still needs a business-rule check that cancellation is rejected.
