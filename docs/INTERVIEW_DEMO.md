# Interview demonstration

The goal is to make the rule, ownership, oracle, and evidence visible within five minutes. Run the complete gate beforehand; use a small live test during the presentation. Do not promise a full three-engine run fits every laptop or network within that time.

## Preparation

Install dependencies/browsers once, then create real evidence:

```sh
npm ci
npm run browsers:install
npm run validate
npm test -- --repeat-each=2
npm run demo:failure
```

The last command intentionally exits `1`. Keep its artifacts. Start the app with `npm start`, open `http://127.0.0.1:3000`, and sign in with the public synthetic credentials `qa.user` / `Password123!`. **After showing the app, stop this manual server with Ctrl+C before live tests or demos.** Playwright owns a fresh server and requires port 3000 to be free; it never reuses the manual process. Open source tabs before speaking:

- `playwright.config.ts`
- `tests/fixtures/tradeflow.fixture.ts`
- `tests/ui/orders.spec.ts`
- `tests/api/orders.spec.ts`
- `tests/contract/responses.spec.ts`
- `.github/workflows/quality.yml`
- `docs/AI_ASSISTED_TESTING.md`

Use the recorded results in `docs/VALIDATION.md` only for the execution they describe. State what was run live and what was run beforehand.

## 30-second version

“TradeFlow Lab is a synthetic local trading workflow created to demonstrate SDET architecture. Every test owns a fresh authenticated order book. Strict TypeScript and runtime schemas support unit, API, contract, integration, and UI coverage. Browser journeys run on Chromium, Firefox, and WebKit. Failures produce trace/report evidence, and CI rejects flaky results. AI can draft scenarios and analyze evidence; human review and deterministic gates decide acceptance.”

Point to the fixture, a normal report, and the contract negative case. Do not imply real brokerage or employer infrastructure.

## 3-minute version

| Time      | Show                                          | Explain                                                                       |
| --------- | --------------------------------------------- | ----------------------------------------------------------------------------- |
| 0:00–0:30 | App blotter and visible synthetic label       | Small product, selected workflows, no real trades                             |
| 0:30–1:10 | Fixture and configuration                     | Per-test session/storageState; worker health; browser projects versus workers |
| 1:10–1:45 | Filled-order API test and contract test       | 409 plus code/state; HTTP 200 can still violate a contract                    |
| 1:45–2:25 | Prepared intentional-failure report and trace | Failed oracle, DOM, actual request/body; diagnosis from evidence              |
| 2:25–3:00 | Actions artifact policy and AI guide          | Finite retention; retry still fails flaky gate; human acceptance              |

## 5-minute version

| Time      | Action and words                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:25 | Show the app. “Every value and credential is synthetic. The product gives tests realistic workflows.” Stop the manual server with Ctrl+C so Playwright can own port 3000. |
| 0:25–0:55 | Show `playwright.config.ts`: service once, UI/integration on three engines, four local/two CI workers, diagnostic retry and flaky failure policy.                         |
| 0:55–1:30 | Show `tradeflow.fixture.ts`: setup, `await use`, cleanup; in-memory storageState and session-owned cloned book; immutable worker health.                                  |
| 1:30–1:55 | Show an order UI test and its focused Page Object. Point to semantic locators and the exact owned record assertion.                                                       |
| 1:55–2:30 | Show the filled-order cancellation API case, then run the targeted case below. Explain 409, structured error, and unchanged FILLED state.                                 |
| 2:30–2:55 | Show normal contract checks and a malformed order fixture. Explain independent OpenAPI validation and runtime parsing.                                                    |
| 2:55–3:25 | Run the intentional UI failure command. Name its expected nonzero exit and separate output directory.                                                                     |
| 3:25–4:10 | Open the demo report and trace. Inspect failed expectation, DOM snapshot, and the relevant HTTP request/body.                                                             |
| 4:10–4:35 | Show GitHub Actions: locked install, static/unit/contract gates, browsers, normal suite, HTML 14 days and failure evidence 7 days.                                        |
| 4:35–5:00 | Show the filled-order AI workflow: agent proposal, human review, exact gates and evidence, accept/edit/reject. Finish with the line below.                                |

Exact live commands, after stopping the manual `npm start` process with Ctrl+C:

```sh
npm run test:api -- --grep "filled"
npm run demo:failure
npm run report:demo
```

Check that the filtered API command selected a test. If report launch or execution takes longer on the interview machine, use the already generated report, explain when it was produced, and keep the same evidence path. After the demo, `npm run report` opens the normal suite's report; the intentional failure does not overwrite it.

End with:

> The app is intentionally small. The engineering focus is reliable evidence, isolation, fast feedback, and maintainable automation.

## 10-minute deep dive

Use the five-minute core, then spend the remaining time on questions the interviewer chooses:

- **Ownership, 90 seconds:** Show session cloning in `app/domain/session-store.ts`; demonstrate two logins do not share created records. Explain why mutable worker authentication would break this model.
- **Contracts, 90 seconds:** Show required fields/status schemas in `contracts/openapi.yaml`, runtime schemas, and the independent validator. Run `npm run demo:contract`, then inspect `npm run report:demo`. HTTP 200 is deliberately insufficient.
- **Cross-layer evidence, 60 seconds:** Show `tests/integration/order-state.spec.ts`: API and UI inspect the same exact ID and token within one test.
- **Triage, 60 seconds:** Explain application/test/data/environment/race/contract classification with a specific trace observation, rather than a guessed cause.
- **Performance, 30 seconds:** Show the optional smoke scope and limitations below.
- **Review, 30 seconds:** Explain one generated test you would reject: a filled-order case that accepts any non-2xx instead of asserting 409 and unchanged state.

## Optional performance explanation

```sh
npm run perf:smoke
```

The smoke starts a separate server at loopback port 3001, authenticates a synthetic session, and sends 120 orders reads with concurrency four. It requires valid HTTP 200 bodies, zero errors, and a loose p95 latency threshold below 250 ms. The output is a local environment-sensitive signal. It is excluded from normal CI and does not establish enterprise load capacity, tail behavior under sustained load, or production trading performance.
