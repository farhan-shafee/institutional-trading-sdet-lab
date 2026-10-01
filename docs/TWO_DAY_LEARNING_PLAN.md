# Two-day learning plan

Budget roughly seven focused hours each day, including breaks. The objective is to explain and modify the evidence architecture. Use a local practice branch or preserve your exercise diff, then restore deliberate faults before finishing. Do not edit expectations to conceal an application defect.

## Day 1: types, browser architecture, ownership, and debugging

### 1. Establish the baseline — 30 minutes

Read `README.md`, `docs/ARCHITECTURE.md`, `package.json`, and `docs/VALIDATION.md`.

```sh
npm ci
npm run browsers:install
npm start
```

Use `qa.user` / `Password123!` in the app. Filter an order, open details, create a LIMIT order, cancel a NEW order, and inspect the FILLED order's unavailable cancellation. **Stop this manual server with Ctrl+C before tests.** Playwright starts and owns its server with `reuseExistingServer: false`; port 3000 must be free. This applies to every normal test, `validate`, and demo command below.

Explain the distinction between synthetic behavior and production trading. Draw the route from browser input to domain validation and session-owned book.

### 2. TypeScript and runtime boundaries — 60 minutes

Read `tsconfig.json`, `app/domain/schemas.ts`, `app/domain/errors.ts`, and `tests/unit/schemas.test.ts`.

```sh
npm run typecheck
npm run test:unit
```

**Change code:** Add a `Number.NaN` quantity case to the schema rejection table. Existing cases already cover fractional, infinite, string, and over-limit quantities; identify what the new case proves. Add an explicit valid LIMIT price case at `0.01` while keeping the missing/nonpositive/nonfinite checks. Run unit checks and typecheck. Explain why a TypeScript cast cannot replace parsing unknown JSON.

### 3. Locators, assertions, and small Page Objects — 75 minutes

Read `pages/LoginPage.ts`, `pages/TradeBlotterPage.ts`, `pages/OrderEntryPage.ts`, `tests/ui/login.spec.ts`, and `tests/ui/orders.spec.ts`.

```sh
npm run test:ui -- --project=chromium
```

**Change code:** Extend one filtering test to combine a side filter with a symbol or status filter. Assert the exact resulting rows and that a known excluded row is absent. Reuse a focused Page Object action if appropriate; add only the locator/action needed. Run the targeted file:

```sh
npx playwright test tests/ui/orders.spec.ts --project=chromium
```

Explain why the assertion waits for the condition, why role/label locators express the user action, and which part belongs in the test rather than the Page Object.

### 4. Fixtures and authentication — 75 minutes

Read `tests/fixtures/tradeflow.fixture.ts`, `test-data/factories/order.factory.ts`, `test-data/fixtures/reference-data.ts`, and `docs/FIXTURES.md`.

```sh
npm run test:integration -- --project=chromium
```

Draw the graph from `authSession` through `storageState` to the built-in browser context. Identify setup, `await use`, and teardown. Explain why the health fixture can be worker scoped and the token cannot.

**Change code:** In `tests/integration/order-state.spec.ts`, extend the API-created case to create a LIMIT order via `await orderFactory({ type: 'LIMIT', limitPrice: 101.25, symbol: 'MSFT', side: 'SELL', quantity: 29 })`. The fixture already submits it by API; do not submit it again. Check that its exact returned ID and price are represented in the UI details, then preserve the existing cancellation/API-readback assertions. Reuse the test's session and no global reset.

### 5. Parallelism and data isolation — 45 minutes

Read `playwright.config.ts`, `app/domain/session-store.ts`, `tests/unit/session-store.test.ts`, and `docs/PARALLELISM_AND_FLAKINESS.md`.

```sh
npm run test:api -- --workers=4
npm run test:integration -- --workers=4
```

**Change code:** Extend a session-store unit case to create a new record in the first book and prove the second book rejects its generated ID with `ORDER_NOT_FOUND`. Keep the existing seed cancellation-isolation assertion. Run `npm run test:unit`. Explain why known seed IDs do not imply shared records, and why worker count alone does not create isolation.

### 6. Tracing and triage — 60 minutes

Read `tests/failure-demo/ui-evidence.spec.ts` and `docs/TRACING_AND_FAILURE_TRIAGE.md`.

```sh
npm run demo:failure
npm run report:demo
```

The first command should intentionally exit `1`. Find the failed expectation, DOM snapshot, and relevant HTTP response. Write a short note distinguishing observed evidence from a cause hypothesis.

**Change code:** Replace only the deliberate demo expectation FILLED with the actual observed status NEW. Run the isolated demo again and confirm it no longer fails for that expectation. Restore the intentional wrong expectation FILLED and rerun to recreate evidence. Never change a normal regression assertion to fit wrong behavior.

End Day 1 by checking your useful exercise diff and running:

```sh
npm run typecheck
npm run lint
npm run test:ui -- --project=chromium
```

## Day 2: HTTP rules, contracts, CI, AI review, and presentation

### 1. API and negative-path oracles — 75 minutes

Read `tests/api/session.spec.ts`, `tests/api/orders.spec.ts`, `app/domain/order-book.ts`, and `docs/API_AND_CONTRACT_TESTING.md`.

```sh
npm run test:api
npm run test:api -- --grep "filled"
```

Explain 401 versus 403, 404 versus 409, and status versus body assertions. **Change code:** Refactor the terminal-order case table to pair each seed ID with its expected starting status. Before POST, assert that the filled case is actually FILLED, the canceled case CANCELED, and the rejected case REJECTED. Preserve `409`, `ORDER_NOT_CANCELABLE`, and complete readback equality. This strengthens the precondition without weakening the existing outcome oracle. Run the targeted and full API checks.

### 2. OpenAPI and runtime contracts — 75 minutes

Read `contracts/openapi.yaml`, `app/domain/schemas.ts`, `tests/contract/openapi-validator.ts`, and `tests/contract/responses.spec.ts`.

```sh
npm run contract:validate
npm run test:contract
npm run demo:contract
npm run report:demo
```

The demo intentionally exits `1`. Explain why document validity, response shape, and business correctness are three different claims.

**Change code:** Add fractional response quantity `1.5` to the malformed-body table. Existing cases already prove zero and string quantities fail; the fraction protects the integer constraint. Assert rejection by the independent OpenAPI validator and runtime schema using the existing case loop. Run the contract suite and confirm the malformed fixture was rejected, not silently accepted.

### 3. CI, reports, and finite artifacts — 60 minutes

Read `.github/workflows/quality.yml`, `package.json`, `playwright.config.ts`, and `docs/CI_CD.md`.

```sh
npm run validate
npm run report
```

Walk through every workflow step, explaining dependency caching versus browser installation and why artifact upload still runs on a failed test. **Change code:** In a practice diff, adjust the documented/report retention together to HTML 10 days and failure evidence 5 days. Run `npm run workflow:validate` and review the YAML. Restore it to the repository policy: HTML 14 days, failure evidence 7 days. Explain why the local run does not prove a hosted Actions execution.

### 4. Human-reviewed AI engineering — 60 minutes

Read `AGENTS.md`, `docs/AI_ASSISTED_TESTING.md`, `docs/prompts/requirements-to-tests.md`, and `docs/prompts/generated-test-review.md`.

Use the filled-order prompt with an agent, or manually write the proposal if no AI tool is available. **Change code:** Implement only a reviewed, nonredundant gap in `tests/api/orders.spec.ts`. If the agent proposes duplicated coverage, reject it with evidence and edit its review note instead of adding noise. Record accept/edit/reject, the reason, and actual gates. No agent recommendation may override a failing check.

### 5. Optional local performance smoke — 30 minutes

Read `scripts/perf-smoke.ts` and the performance notes in `docs/INTERVIEW_DEMO.md`.

```sh
npm run perf:smoke
```

Record request count, errors, and latency from the actual output. This starts a separate local smoke server. Explain why a small local burst and loose environment-dependent threshold are excluded from normal CI and cannot establish production capacity.

### 6. Repeated suite and adversarial review — 45 minutes

Read `docs/TEST_STRATEGY.md`, `docs/INTERVIEW_QUESTIONS.md`, and your exercise diff.

```sh
npm run typecheck
npm run lint
npm run validate
npm test -- --repeat-each=2
```

Check all three browser projects and the browser-free service project. Identify any redundant exercise tests, misleading assertions, shared state, or unproven claims. Keep useful reviewed changes; restore deliberate faults. The intentionally failing demos stay outside these normal gates.

### 7. Rehearse the interview — 60 minutes

Read `docs/INTERVIEW_DEMO.md`. Rehearse the 30-second, 3-minute, then 5-minute versions. Prepare a normal report and one demo report before presenting. Explain the first ten questions in `docs/INTERVIEW_QUESTIONS.md` while pointing to concrete source/evidence. If an explanation depends on a helper you cannot describe, inspect that helper before using it in the demo.
