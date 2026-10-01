# TradeFlow Lab implementation plan

Interview and learning lab only. All users, instruments, orders, positions and credentials are synthetic. The user's supplied brief is the scope and acceptance specification.

## Architecture decisions

- Node 24 LTS, npm, strict TypeScript and a native HTTP server run with `tsx`. Semantic HTML, CSS and browser TypeScript keep the product small.
- Zod validates requests and runtime responses; OpenAPI 3.0 describes the wire API. Contract tests also validate live responses against the OpenAPI schemas independently of application TypeScript types.
- Every successful login creates a fresh session with a cloned seed order book. Bearer tokens identify that isolated book; reader credentials demonstrate a real 403 boundary within the synthetic model. DELETE /api/session releases session data.
- UI uses localStorage authentication state. Test fixtures authenticate through the API and supply in-memory Playwright storageState, with teardown deleting the session. No checked-in tokens or global reset endpoint.
- Chromium, Firefox and WebKit run UI/integration projects; API and contract tests run once in a browser-free project. Built-in request/page/context fixtures remain visible. A worker fixture caches immutable health/reference metadata; mutable sessions remain test scoped.
- Retries: zero locally, one in CI for diagnosis, with failOnFlakyTests enabled. Failure artifacts are finite and normal tests never include intentional failures.

## Milestones and evidence

1. **Foundation:** package scripts, strict configuration, lint/format, ignores. Check dependency install and type/lint configuration; commit foundation and this plan.
2. **Application/domain/API:** domain tests first, server, UI, request validation, roles, session isolation, structured errors, OpenAPI. Run domain tests, health and specification validation; commit app/API.
3. **Automation:** factories, small page objects, fixtures, UI/API/contract/integration tests. Run typecheck, lint and targeted API/UI suites; commit automation.
4. **Evidence/CI:** isolated failure and contract-break demos, performance smoke, GitHub Actions, artifact retention. Run demos and inspect evidence, validate workflow; commit evidence/CI.
5. **Learning materials:** README, strategy, fixture/triage/AI guides, 30+ Q&A, two-day code exercises and timed demos. Audit commands/links against implementation; commit documentation.
6. **Adversarial review:** independently inspect domain/API boundaries, fixtures, browser behavior, OpenAPI parity, isolation and claims. Fix material issues in focused commits.
7. **Final acceptance:** run typecheck, lint, validate and a second full multi-browser parallel run; verify expected demo failures and artifacts; record counts, commands, limitations and commits; commit evidence with a clean working tree.

## Parallel ownership

- Application task owns `app/`, `contracts/`, `tests/unit/`.
- Automation task owns `pages/`, `test-data/`, `tests/fixtures/`, `tests/ui/`, `tests/api/`, `tests/contract/`, `tests/integration/`, `tests/failure-demo/`.
- Documentation task owns documentation except this plan, README and AGENTS. Implementation must remain human reviewable; root integrates, runs gates, reviews and commits.
- Root owns package/configuration, scripts, GitHub Actions, coordination and final verification. Only root performs dependency installation and Git commits.

## Wire interface

`POST /api/session` accepts `{username,password}` and returns `{token,user:{username,role}}` (200); users `qa.user` / `qa.viewer` share the public synthetic password `Password123!`. Each session has its own seed book. `DELETE /api/session` returns 204. Errors use `{error:{code,message}}`.

`GET /api/orders` supports symbol/side/status and returns `{orders:Order[]}`. `GET /api/orders/:id`, `POST /api/orders` (201), `POST /api/orders/:id/cancel` return `{order:Order}`. Order: `id,symbol,side,quantity,type,status,createdAt`, optional `limitPrice`; MARKET rejects limitPrice; LIMIT requires positive finite limitPrice. Quantity: positive integer up to 1,000,000. Symbols: AAPL/MSFT/NVDA/SPY. Sides BUY/SELL. Statuses NEW/PARTIALLY_FILLED/FILLED/CANCELED/REJECTED. Only NEW/PARTIALLY_FILLED can cancel; conflicts 409, unknown ID 404, invalid inputs 400, absent/invalid token 401, reader mutation 403.

`GET /api/positions` returns `{positions:[{symbol,quantity,averagePrice}]}` (static synthetic read model). `GET /health` returns `{status:'ok',service:'TradeFlow Lab',synthetic:true}`. Server listens on 127.0.0.1:3000 by default, supports PORT, and exposes no real integrations.

Seeds use stable IDs `seed-new-aapl`, `seed-partial-msft`, `seed-filled-nvda`, `seed-canceled-spy`, `seed-rejected-aapl` and fixed timestamps. Contract fault demonstration is browser route interception of HTTP 200 with malformed data, scoped to the explicit failure-demo project; regular contract tests assert the malformed response is rejected.
