# Interview questions and answers

Use these as explanations to demonstrate in source and evidence, not claims of employer experience. The first ten are the essentials for this lab.

1. **Why does this application stay so small?** The purpose is test engineering. A minimal HTTP server and browser client make the ownership, contract, assertions, and evidence easy to inspect. Additional product frameworks would add concepts without necessarily strengthening the test signal.

2. **What does strict TypeScript buy you, and what does it not prove?** It finds incompatible values and unsafe nullable assumptions before execution. It cannot validate a JSON body received over HTTP; runtime schemas must check that boundary. See `tsconfig.json` and `app/domain/schemas.ts`.

3. **What is a fixture, and why prefer one to repeated beforeEach logic?** A fixture is a typed, reusable dependency with setup and teardown in the same lifecycle. A test requests what it needs; dependency composition is explicit. Hooks remain useful for genuinely file-local sequencing.

4. **How do test-scoped and worker-scoped fixtures differ?** Test scope creates a fresh value per test; worker scope reuses one per process. This lab keeps tokens and mutable books test scoped, while immutable health metadata can be worker scoped. A worker cannot safely depend on a shorter-lived test resource.

5. **How is authentication reused without sharing mutable state?** Each test logs in through the API, receives a fresh token/book, and provides in-memory `storageState` with `tradeflow.token`. UI and API in the same test share that session; other tests do not. Teardown revokes the token.

6. **Why is this suite safe to parallelize?** Login clones a book rather than sharing one user's mutable records. Fixed seed IDs are local to each token. Tests assert their own created ID and clean up their session, so workers, browsers, and retries cannot overwrite a shared order.

7. **Why is HTTP 200 insufficient for a contract test?** A response can succeed at transport and contain missing fields, invalid enum values, or the wrong quantity type. Normal contract tests reject malformed bodies; `demo:contract` shows an actual 200 response failing schema validation.

8. **How do you keep retries from hiding flaky tests?** Local retries are zero. CI allows one diagnostic retry but `failOnFlakyTests` makes a pass-after-failure fail the gate. Investigate the first failure using evidence and fix the cause instead of increasing retries.

9. **What do you inspect first in a trace?** The failed expectation, then the preceding action and DOM snapshots, then the relevant request/body and console output. Connect the owned order ID and actual response to the rule before deciding whether the defect is in product, test, data, or environment.

10. **What makes AI-generated tests acceptable?** Human review confirms the rule, precondition, meaningful oracle, ownership, cleanup, awaits, and locators. Targeted tests and deterministic static/full gates supply executable evidence. The human accepts, edits, or rejects; AI cannot overrule a failed gate.

11. **What is a browser project versus a worker?** A project is a configuration/coverage dimension such as Firefox. A worker is a process that schedules execution. Four workers do not mean four browsers, and browser-free API checks run once in the service project.

12. **What does fullyParallel do?** It permits independent tests within files to run concurrently in addition to file-level concurrency. It does not create state isolation. The fixture and server data model must already make concurrent operations safe.

13. **Why avoid serial tests here?** A serial chain couples results to execution order and makes an earlier failure affect later cases. Independent setup gives each case its own precondition and makes isolated reproduction possible. Serial execution can be legitimate for an inseparable workflow, but it is unnecessary for these orders.

14. **What is auto-waiting versus a web-first assertion?** Actions wait for conditions such as visibility and actionability. Assertions such as `toHaveText` repeatedly observe the expected UI condition within their timeout. A successful click does not prove the resulting business state, so the assertion is still necessary.

15. **Why use getByRole and getByLabel?** They express semantics a user interacts with and tend to survive cosmetic layout changes. Scoped locators also identify the exact owned order. A test ID is appropriate when a stable identity has no useful accessible selector.

16. **Why is waitForTimeout a poor readiness strategy?** It assumes a timing bound without proving a condition: too short is flaky and too long is slow. Wait for the intended response or observable state with an appropriate assertion. A timeout failure should explain the missing condition.

17. **Where should Page Object assertions live?** Business expectations stay in tests so reviewers can see the oracle. Page Objects provide focused locators and actions. A small reusable readiness check can be reasonable, but a giant object hiding every assertion obscures failures and adds navigation dependencies.

18. **What does APIRequestContext provide?** HTTP requests, response access, configurable headers/base URL, and isolated request context state. This lab's `apiClient` is the raw authenticated context rather than another API abstraction. Built-in `request` remains visible for anonymous/authentication cases.

19. **How do authentication and authorization differ?** Authentication identifies the caller: missing or invalid bearer tokens receive `401`. Authorization determines allowed actions: a valid viewer token receives `403` on mutations. Checking only `401` leaves the role boundary untested.

20. **Why check both response status and body?** A `400` from the wrong validation path is not proof of the intended rule. Structured error codes distinguish rejection reasons; successful bodies and readback prove resulting state. Generic `expect(response.ok()).toBeTruthy()` misses these distinctions.

21. **What belongs in a REST negative-path matrix?** Missing/invalid credentials, invalid tokens, unauthorized roles, missing fields, invalid enum/type/range, unknown IDs, and forbidden status transitions. Parameterize meaningful invalid cases while keeping the expected code and reason visible.

22. **Why distinguish 404 from 409?** `404` means this session has no such resource. `409` means the resource exists but its current state prevents the action. A filled-order test must establish existence so an accidental `404` cannot pass as the business conflict.

23. **How do you prove an integration test crosses layers?** Create an order through the API, inspect that exact ID in the browser, or create through the UI and read it through the API using the same session. Seed data alone can make a false integration test pass without exercising a write.

24. **What is OpenAPI document validation versus contract testing?** Document validation checks specification syntax and structure. Live contract tests check actual responses against it. A perfectly valid specification may still be out of sync with the server, and a well-shaped response may still violate a business rule.

25. **Why not use shared TypeScript types as the sole contract?** The same wrong assumption can compile on producer and consumer, and static types do not inspect runtime JSON. Zod provides executable validation; an independently interpreted OpenAPI schema adds a second oracle for the wire boundary.

26. **What does the HTTP-200 contract demo teach?** Transport success and semantic data validity are separate. Route interception returns malformed synthetic orders only in an explicit demo project, and a schema assertion fails. No permanent server fault is needed, so normal tests remain unaffected.

27. **What is static versus generated test data here?** Symbols, fake credentials, stable seed IDs, and fixed seed timestamps are reference data. Each session receives cloned records; factories build new inputs with explicit overrides. Generated order IDs come from the server and should be used in assertions.

28. **What cleanup should a fixture own?** It releases exactly what it created: revoke its session and dispose owned contexts. Deleting one session also removes its generated orders. A fixture must not reset another test's state or delete shared reference data.

29. **What does async/await actually do?** An async function returns a Promise; `await` suspends that function until fulfillment or throws on rejection. It does not make all asynchronous code serial globally. Missing an await can allow the test to finish before the operation or assertion is complete.

30. **When should you use Promise.all?** For independent operations whose results can be checked together, such as unrelated read-only queries. Dependent transitions such as create-then-cancel must remain ordered. `forEach(async ...)` does not await its callbacks as a group.

31. **How should unknown JSON be typed?** Treat a boundary value as unknown and validate/narrow it with a runtime schema before domain use. Casting to `Order` silences the compiler without creating runtime safety. Use discriminated unions for known variants such as MARKET versus LIMIT where they improve invariants.

32. **What does trace retention trade off?** Capturing all successes improves availability but multiplies storage and review noise. Normal traces occur on the first retry; screenshots/videos are retained on failure. Demos use tracing from the start; local zero-retry reproductions need explicit `--trace on`.

33. **What is in the CI artifacts and why finite retention?** The HTML report keeps results/attachments for 14 days; failure evidence keeps available traces, screenshots, videos, and attachments for 7 days. Finite retention balances investigation time with storage. Files may be absent if a prerequisite gate failed first.

34. **Why npm ci in GitHub Actions?** It installs using the committed lockfile and fails when package metadata is inconsistent with it. It makes dependency resolution reproducible; it does not remove the need to review dependency changes. npm cache is separate from browser and OS dependency installation.

35. **Why not gate normal CI on the performance threshold?** A shared runner's scheduling and resource load can distort latency. The optional smoke checks a small local burst, status/schema validity, errors, and a loose p95 threshold. It is a local signal, not a capacity, soak, or distributed load claim.

36. **Which trading-system concerns does this lab demonstrate?** Status-transition integrity, role boundaries, input validity, resource ownership, and UI/API agreement. Real systems also require precision rules, idempotency, ordering, reconciliation, auditability, resilience, and external-protocol testing; this repository does not claim to implement them.

37. **Why is a disabled Cancel button insufficient?** A caller can bypass the browser and send the REST mutation directly. The server must enforce the state rule and role permission. UI tests prove affordances; API tests prove authoritative rejection and unchanged state.

38. **How do you separate an application defect from automation failure?** Compare the agreed rule with actual request, response, owned state, and rendered result. Wrong target, missing await, or incorrect oracle points toward automation. A valid request producing wrong state points toward application behavior; do not classify solely by the assertion text.

39. **What is a primary versus supporting agent?** The primary maintains scope, file ownership, integration, and evidence. A supporting agent works in a bounded area such as contract review. Both need relevant context and scoped tools; a subagent's confident summary still needs diff review and executable verification.

40. **What evidence would you present to a skeptical hiring manager?** A readable requirement-to-test path, session ownership in fixtures, a negative API rule with unchanged state, independent contract checks, repeated multi-browser results, an intentional failure trace, and CI artifact policy. State actual counts and limitations from `docs/VALIDATION.md` rather than claiming production experience.

Further reading: [Playwright fixtures](https://playwright.dev/docs/test-fixtures), [parallelism](https://playwright.dev/docs/test-parallel), [API testing](https://playwright.dev/docs/api-testing), [TypeScript strict mode](https://www.typescriptlang.org/tsconfig/strict.html), and [OpenAPI 3.0.3](https://spec.openapis.org/oas/v3.0.3.html).
