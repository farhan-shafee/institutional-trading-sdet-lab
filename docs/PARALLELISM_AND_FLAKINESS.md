# Parallelism and flakiness

The engineering challenge is safe ownership, not setting `workers=8`. TradeFlow Lab separates mutable books at login, so concurrent tests can reuse `qa.user` and stable seed IDs without mutating each other's records.

## Execution vocabulary

| Concept         | Meaning in this repository                                                          |
| --------------- | ----------------------------------------------------------------------------------- |
| Project         | Named configuration: `service`, `chromium`, `firefox`, `webkit`                     |
| Worker          | Independent process executing scheduled tests                                       |
| Parallel files  | Playwright's normal file-level concurrency                                          |
| `fullyParallel` | Allows independent tests within files to be scheduled concurrently                  |
| Serial group    | Ordered tests with coupled lifecycle; intentionally unnecessary here                |
| Repeat          | Another execution of a test, used to search for intermittent behavior               |
| Retry           | A diagnostic rerun of a failure, not evidence that the first failure never happened |

These distinctions follow [Playwright's parallel execution model](https://playwright.dev/docs/test-parallel). Browser projects are coverage dimensions; workers are concurrency. More workers do not add browser coverage.

## Data ownership

Reference constants, fixed seed timestamps, and valid symbols are immutable. Login clones orders into a token-owned book. Server-generated IDs identify new records, and tests assert the returned ID. The pure `buildOrder` helper constructs inputs; the `orderFactory` fixture creates records in its test's book. Teardown deletes the session and all its orders. No reset endpoint, serial dependency, global authentication state file, or shared mutable account book is required.

The worker health fixture freezes read-only environment metadata and disposes its HTTP context. It does not cache a bearer token or create orders. Retried tests receive new test-scoped resources, so a previous partial mutation cannot poison the rerun.

## Waiting and assertions

Use role/label locators and Playwright's actionability checks. After an action, use a web-first assertion such as `await expect(row).toContainText('CANCELED')` on the exact owned row. Wait for the condition that proves completion. A fixed delay neither proves readiness nor explains failure.

API calls use awaited promises; negative assertions inspect actual response bodies. Do not start requests without awaiting them or use `forEach(async ...)`. Independent read-only checks may use `Promise.all`; state transitions must retain the ordering the rule requires.

## Retry policy

Local retries are zero. CI allows one retry for diagnosis and enables `failOnFlakyTests`, so an initial failure followed by a pass still fails the gate. Playwright classifies such outcomes as flaky; see the [retry guide](https://playwright.dev/docs/test-retries). A retry produces more information, not a reliability fix.

Before changing a timeout, determine whether the expected condition is correct, data belongs to the test, the application completed the action, and the environment is healthy. Keep a reproduction and evidence for an actual intermittency defect.

## Useful checks

```sh
npm test -- --repeat-each=2
npm run test:api -- --workers=4
npm run test:integration -- --workers=4
npm run test:ui -- --project=chromium --workers=4
```

Adjust worker count for machine resources; do not interpret a resource-starved laptop as a trading capacity result. Record project, worker count, retries, failure location, and owned order ID when investigating. More repetition is justified after a concurrency change or unresolved flaky observation, not as an endless ritual after gates pass.
