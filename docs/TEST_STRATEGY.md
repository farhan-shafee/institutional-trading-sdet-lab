# Test strategy

The highest risks are accepting invalid input, allowing an unauthorized mutation, permitting an invalid status transition, leaking state between sessions, and displaying stale or malformed server state. Coverage follows those risks before adding browser permutations.

## Layers and their oracles

| Layer                   | Owns                                         | Checks                                                                       | Avoids                                   |
| ----------------------- | -------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------- |
| Unit                    | Domain/schema rules and derived presentation | Valid/invalid input, cancelable statuses, status partitions and cost basis   | Network and browser setup                |
| API                     | REST behavior and resource ownership         | Status, structured body, state transition, 401/403/404/409                   | Repeating every validation through UI    |
| Contract                | Executable wire compatibility                | Zod response parsing and independent OpenAPI schemas                         | Treating HTTP 200 as proof of valid data |
| Integration             | State and response behavior across layers    | API-created state in UI, UI-created state in API, malformed-200 UI rejection | Global seeded mutation shared by tests   |
| UI                      | Selected user journeys                       | Login, filters, details, entry validation, cancellation                      | Exhaustive invalid-payload matrices      |
| Local performance smoke | Basic local service signal                   | Request count, errors, elapsed latency                                       | Claims about enterprise capacity         |

The API/contract `service` project runs once. Chromium, Firefox, and WebKit run UI and integration cases. Browser-free API tests do not need three copies merely because three engines exist.

Hosted-boundary cases also run once in `service`, each owning an ephemeral loopback server and request context. They inject a monotonic clock to verify expiration/admission boundaries without sleeps, and use HTTP request-event barriers for revocation/expiry during an unfinished body. They validate statuses, literal error codes, runtime/OpenAPI bodies, Retry-After, unchanged books, and recovery. Configuration/domain checks cover finite bounds and resource cleanup. The existing normal fixtures and local-mode expectations remain unchanged; public limits never depend on a hidden CI exemption.

## Risk-based negative paths

Missing or invalid bearer tokens receive `401`. Authenticated viewers receive `403` on mutation. Bad symbol, quantity, type, or required fields receive `400`; unknown records receive `404`; canceling FILLED, CANCELED, or REJECTED records receives `409`. Assertions inspect `error.code` as well as status so a generic server error cannot masquerade as the intended boundary.

Creation and cancellation tests verify resulting state. Integration tests inspect the exact owned order ID, rather than accepting any row containing a familiar symbol. `tests/integration/contract-boundary.spec.ts` intercepts an actual HTTP 200 response, confirms malformed data is rejected by both validators, and checks the UI's contract error. UI tests check unavailable actions and validation feedback; API tests remain authoritative when client controls are bypassed.

## Data and parallel execution

Productization regressions protect keyboard navigation, visible disabled viewer controls, full-book metrics under filters and mutations, fixed synthetic quotes, observed browser activity, and unavailable first-read states. Controlled response gates verify that an older full-book response cannot erase an accepted creation and that a prior-session positions response cannot populate a new session. Literal expectations keep metrics/quotes independent of their implementation helpers. Responsive overflow checks complement actual screenshot inspection; they do not certify visual accessibility.

Fixed reference symbols and seed IDs are safe to share. Mutable books are cloned per authenticated test session. `buildOrder` produces valid synthetic inputs with explicit overrides; `orderFactory` creates and checks a test-owned server record. Invalid-payload cases bypass the valid factory deliberately and send their literal faults to the API. Session teardown releases all created orders at once. No test depends on a previous test's login or creation.

Isolation is checked directly, then exercised by `fullyParallel`, several workers, multiple projects, and repeated runs. A green repeated run increases confidence; it does not prove there can never be a race. [Parallelism and flakiness](PARALLELISM_AND_FLAKINESS.md) explains the operational details.

## Quality gates and evidence

```sh
npm run typecheck
npm run lint
npm run validate
npm test -- --repeat-each=2
```

`validate` first requires full and production-only npm audits to pass, then runs static checks, formatting, OpenAPI validation, workflow validation, domain tests, and the normal Playwright suite. Stop a manually started app before this command: tests own port 3000. CI uses conservative parallelism, finite artifacts, and a retry policy that fails the gate for flaky tests. An assertion failure is evidence to investigate; passing after retry does not erase it.

It also builds the complete production artifact and runs `smoke:production`: a clean production-only installation outside the checkout, native Node startup from an unrelated working directory, real wire workflows/resource limits, and one intentional wait for a one-second session lifetime. Ubuntu additionally verifies SIGTERM with an unfinished request body and the bounded force-close path; Windows termination is explicitly reported as forced. This smoke is separate from unit/Playwright scenario counts. Application admission does not certify deployed TLS, DNS, proxy identity, edge protection, billing controls, or capacity. See [deployment readiness](PUBLIC_DEPLOYMENT_READINESS.md).

The two intentional-failure commands are separate demonstrations. One fails a visible UI expectation; the other exposes a malformed body returned with HTTP 200. Both must remain excluded from normal tests. See [triage](TRACING_AND_FAILURE_TRIAGE.md) and [actual validation evidence](VALIDATION.md).

## Review standard

A test must establish the intended precondition, perform a meaningful action, and assert an independently observable outcome. Reject checks that mirror implementation details, only prove clickability, accidentally assert seeded data instead of a created record, or pass without the feature. Keep expectations close to tests and helper layers shallow enough for trace actions to explain failures.

No skipped normal tests, arbitrary sleeps, brittle CSS/XPath chains, shared mutable login, or unreviewed assertion reductions are accepted as fixes. New domain behavior needs a human-reviewed rule, a targeted regression, and the full gates.
