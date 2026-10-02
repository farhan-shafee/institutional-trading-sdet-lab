# TradeFlow Lab delivery report

Prepared October 1, 2026. TradeFlow Lab is a local synthetic interview and learning repository. The implementation results below preserve the historical local baseline at `901f162`, recorded in delivery commit `5897203`. [VALIDATION.md](VALIDATION.md) also records the inspected hosted Actions baseline at `5897203`. [AUDIT.md](AUDIT.md) records the later hostile audit and current verification. No production trading, employer experience, or human acceptance is implied.

## 1. What was built

A compact trading-style application with login, a seeded order blotter, symbol/side/status filters, inline order details, MARKET/LIMIT submission, eligible cancellation, and a synthetic positions view. The primary deliverable is its layered automation, deterministic fixtures, independent contract checks, diagnostics, CI configuration, and learning material.

## 2. Architecture

Node 24 runs a native local HTTP server with strict TypeScript. Zod validates runtime requests/responses; esbuild bundles browser TypeScript into semantic HTML/CSS. OpenAPI describes the REST interface. Each login clones a synthetic order book; a bearer token owns it. The browser stores that fake token in localStorage. [Architecture details](ARCHITECTURE.md) explain the boundaries and deliberate limits.

## 3. Test coverage

The historical local full gate passed 31 domain unit checks and 141 Playwright executions: 38 API, 16 contract, 26 UI cases on each engine (78 executions), and 3 integration cases on each engine (9 executions). UI coverage includes login/logout, filters, validation, details, submission, cancellation, stale response ordering, session restoration, viewer identity, and accepted price display. Integration proves state across API/UI and runtime rejection of an actual malformed HTTP 200 response. Current audit counts and results are recorded separately in [AUDIT.md](AUDIT.md).

## 4. Fixtures implemented

Custom `authSession`, in-memory `storageState`, raw `apiClient` APIRequestContext, `authenticatedPage`, API-creating `orderFactory`, and `tradeBlotterPage` are test scoped. The worker-scoped `environment` shares frozen health metadata only. Built-in `page`, `context`, `request`, `browser`, and `playwright` remain visible. Setup, `await use`, DELETE teardown, and context disposal are explained in [FIXTURES.md](FIXTURES.md).

## 5. Parallelism design

Each test owns a fresh token and cloned book, including isolated seed IDs and generated orders. No test order or shared reset is required. API/contract execute once in `service`; Chromium, Firefox, and WebKit execute browser journeys. `fullyParallel` uses four local workers and two in CI. Mutable tokens remain test scoped; retries receive fresh resources.

## 6. Tracing and artifacts

Normal tracing starts on the first retry; screenshots capture failures and videos are retained on failure. Local retries are zero, so a local reproduction can use `--trace on`. Intentional demos trace from the start and write separately to `demo-results/` / `demo-report/`. Normal HTML reports and failure evidence have 14-day and 7-day CI retention respectively. Both final demos exited 1 at their intended assertion and produced verified trace, screenshot, video, error-context, and HTML evidence. The UI screenshot shows actual NEW status; decoded contract trace records actual HTTP 200 with malformed quantity `"many"` rejected by AJV.

## 7. API and contract coverage

Tests assert status, structured body, and meaningful resulting state for authentication, protected reads, viewer rejection, input validity, creation, filtering, ownership, cancellation conflicts, unknown records, malformed JSON, content type, and size limits. Contract checks validate the document, parse runtime bodies through Zod, and use AJV against the live published OpenAPI independently of app types. The historical baseline included eight malformed-body variants and browser interception. The current audit expands that matrix to 14 variants; its execution evidence is recorded in [AUDIT.md](AUDIT.md). These checks demonstrate that HTTP 200 alone does not establish validity.

## 8. CI/CD design

GitHub Actions configures Ubuntu, Node 24, npm caching/locked install, typecheck, lint, formatting, OpenAPI/workflow validation, unit checks, browser/OS dependency installation, and the normal suite. Uploads retain the HTML report even after failure and available failure attachments on failure. One diagnostic retry is allowed, while `failOnFlakyTests` rejects a pass-after-failure. The historical local `CI=true` configuration run passed 141 executions in 53.203 seconds with two workers and no flaky/skipped/unexpected results.

[Hosted Actions run 36932536997](https://github.com/farhan-shafee/institutional-trading-sdet-lab/actions/runs/36932536997), attempt 1 at `5897203`, passed on Ubuntu 24.04.5 with Node 24.21.0 and npm 11.19.0: 31 unit checks and 141 Playwright executions in 155.117 seconds, two workers, zero failures/flaky/skipped results or actual retries. Its 14-day HTML artifact upload succeeded. The seven-day failure-evidence upload was skipped, leaving hosted failure-path behavior unverified. The current audit fixes need another hosted run; this task forbids pushing them.

## 9. AI-assisted workflow

`AGENTS.md` and [AI_ASSISTED_TESTING.md](AI_ASSISTED_TESTING.md) define bounded primary/supporting agents, repository context, scoped tools, cost/context discipline, evidence-based analysis, and mandatory human review before acceptance. Five prompt templates cover scenarios, triage, diff-based regression selection, OpenAPI changes, and generated-test review. The filled-order example connects the rule to `409`, `ORDER_NOT_CANCELABLE`, unchanged state, execution evidence, and a human accept/edit/reject decision. No human acceptance is fabricated.

## 10. Performance smoke

The optional local smoke owns an ephemeral loopback server. Recorded baseline: 120 requests, concurrency four, zero errors, p95 5.25 ms against a loose 250 ms threshold. A final run recorded the same request/error counts and p95 8.59 ms. An occupied-port ownership check confirmed zero requests reached a separate port-3001 server. The smoke validates response status/body, cleans up its session/server, and stays outside normal CI. It is not enterprise load testing.

## 11. Exact validation commands with recorded evidence

```sh
npm run validate
```

That command executed these gates in order:

```sh
npm run typecheck
npm run lint
npm run format:check
npm run contract:validate
npm run workflow:validate
npm run test:unit
npm test
```

Additional recorded checks:

```sh
npx playwright test tests/ui/lifecycle.spec.ts --project=chromium
npx playwright test tests/ui/lifecycle.spec.ts
npm run perf:smoke
npx tsx .local/perf-ownership-check.ts
npm test -- --repeat-each=2
npm run demo:failure
npm run demo:contract
npm test
```

The first targeted lifecycle command was deliberately run before the correction and failed 9 cases; the post-fix cross-browser command passed 30. Additional stale-restoration regressions were run before/after their fix, as recorded in the validation document. The `.local` ownership script is a local verification aid and is not included in a fresh clone. The local CI configuration set `CI=true` for `npm test`, then restored the environment. The demo commands intentionally exited 1; the subsequent normal suite passed. [VALIDATION.md](VALIDATION.md) records each outcome and the exact PowerShell CI configuration recipe.

## 12. Counts and results

The historical local full gate records **31 unit checks passed** and **141 Playwright executions passed in 41.4 seconds**, with no unexpected failures, flaky results, or skipped tests. Project totals: service 54; Chromium 29; Firefox 29; WebKit 29. There are 83 distinct Playwright cases before browser expansion. The repeated suite passed **282 executions in 80.250 seconds**; the local CI configuration passed **141 in 53.203 seconds**. Both recorded zero unexpected failures, flaky results, and skipped tests. The separate normal run after both final demos passed **141 in 41.284 seconds**, again without unexpected/flaky/skipped results. These counts are preserved baseline evidence, not counts for the current audit changes.

## 13. Focused Git commits

| Commit    | Subject                                                              |
| --------- | -------------------------------------------------------------------- |
| `df6bb6b` | chore: establish strict TypeScript and Playwright lab foundation     |
| `18c4769` | feat: model validated synthetic orders and isolated sessions         |
| `e257cfb` | feat: serve synthetic TradeFlow workflows and OpenAPI contract       |
| `189cfc5` | test: add isolated fixtures and layered cross-browser automation     |
| `6b29bc2` | ci: gate flaky results and retain bounded failure evidence           |
| `3477e77` | docs: add interview demos curriculum and human-reviewed AI workflows |
| `4ed4d2e` | fix: preserve selected orders and sessions through delayed responses |
| `862cfa0` | perf: smoke test only an owned synthetic loopback server             |
| `901f162` | fix: prevent stale restoration from overwriting a newer login        |
| `5897203` | docs: record verified delivery and interview evidence                |

The initial local delivery record ended at the evidence commit and did not claim a push or pull request. The later push-triggered hosted run at `5897203` is now recorded above. The current audit's authorized scope excludes pushing its fixes.

## 14. Known limitations

The historical baseline was validated locally on Windows with Node 24.19.0, npm 11.19.1, and Playwright 1.63.0, and later on hosted Ubuntu 24.04.5 with Node 24.21.0 and npm 11.19.0. macOS has not been exercised; the current audit fixes have not run on Actions. State is in memory, sessions have no expiry TTL, and positions are static. Public fake credentials/localStorage illustrate a testing pattern, not production security. No matching engine, fills, brokerage connectivity, persistence, audit/reconciliation, real financial precision, or distributed resilience is implemented. The OpenAPI helper supports the schema constructs used by this lab. Local smoke latency is environment dependent. Human review remains a separate acceptance decision.

## 15. Exact five-minute demo commands

Prepare installed dependencies, browsers, the normal report, and one intentional-failure report before the interview. To show the app:

```sh
npm start
```

Open `http://127.0.0.1:3000` and use `qa.user` / `Password123!`. **Stop the manual server with Ctrl+C before the live test commands:** Playwright always owns a fresh server on port 3000.

```sh
npm run test:api -- --grep "filled"
npm run demo:failure
npm run report:demo
```

The first command selects the filled-order conflict case. The second intentionally exits 1; inspect its trace in the report. Then show workflow artifact handling and the AI human-review example. [INTERVIEW_DEMO.md](INTERVIEW_DEMO.md) provides the complete 30-second, 3-minute, 5-minute, and 10-minute scripts.

## 16. First five files to study

1. [playwright.config.ts](../playwright.config.ts): project selection, workers, retries, flaky gate, server and evidence policy.
2. [tradeflow.fixture.ts](../tests/fixtures/tradeflow.fixture.ts): setup/use/teardown, auth state, mutable ownership and worker metadata.
3. [orders UI tests](../tests/ui/orders.spec.ts): semantic locators, focused Page Objects and visible journey assertions.
4. [orders API tests](../tests/api/orders.spec.ts): status/body/state oracles, boundaries and isolated mutations.
5. [responses contract tests](../tests/contract/responses.spec.ts): live OpenAPI validation and malformed-body rejection.

Next, inspect `tests/ui/lifecycle.spec.ts` to understand the adversarial review's controlled response-order regressions.

## 17. Ten interview questions to answer

1. Why is the product small, and which quality risks receive the deepest coverage?
2. What does strict TypeScript prove, and why is runtime JSON validation still required?
3. What does a fixture own, and how does setup / `await use` / teardown work?
4. Why are mutable authentication/books test scoped while health metadata is worker scoped?
5. How does in-memory storageState reuse login without sharing records across tests?
6. What makes increasing workers safe, and how do projects differ from workers?
7. How can HTTP 200 fail a contract, and why use an independent OpenAPI oracle?
8. Why check `409`, `ORDER_NOT_CANCELABLE`, and unchanged FILLED state together?
9. How do tracing, controlled response gates, and a diagnostic retry reveal failure without concealing flakiness?
10. What must a human review before accepting AI-generated tests, and what happens when AI disagrees with a gate?

Concise model answers and 30 additional questions are in [INTERVIEW_QUESTIONS.md](INTERVIEW_QUESTIONS.md). The goal is to explain these points from executable source and actual evidence, not memorize a claim about employer or production experience.
