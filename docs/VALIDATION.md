# Validation evidence

Recorded on October 1, 2026 for TradeFlow Lab, a local synthetic interview and learning lab. This record separates executed checks, inspected artifacts, static review, and verification limits. Passing checks do not imply production trading suitability or human acceptance of generated behavior.

## Environment and tested snapshot

| Item                            | Observed value                       |
| ------------------------------- | ------------------------------------ |
| Host                            | Windows; PowerShell                  |
| Node.js                         | 24.19.0                              |
| npm                             | 11.19.1                              |
| Playwright Test                 | 1.63.0                               |
| Branch                          | `codex/tradeflow-lab`                |
| Application/review-fix snapshot | `901f162`                            |
| Browser engines executed        | Chromium, Firefox, WebKit            |
| Normal local configuration      | 4 workers, fully parallel, 0 retries |

The full validation run started at 4:34 p.m. America/New_York. Its machine-readable evidence is `.local/final-validation-results.json`; command output is `.local/final-validation.log`. These local evidence files and generated reports are intentionally ignored by Git. This committed document records their inspected results; a fresh clone generates its own artifacts by running the commands below.

macOS, Linux, and hosted GitHub Actions execution have not been performed during this implementation. The Linux workflow is configured and structurally checked; local execution with `CI=true` is a separate configuration check, not a hosted Actions run.

## Full local gate

`npm run validate` completed successfully. Its sequence was:

```sh
npm run typecheck
npm run lint
npm run format:check
npm run contract:validate
npm run workflow:validate
npm run test:unit
npm test
```

The log records strict compiler checks, zero-warning lint, successful formatting, a valid OpenAPI document, and parsed workflow YAML with the expected gates and finite artifact-retention checks. The unit runner reports **31 passed, 0 failed, 0 skipped**. Playwright reports **141 passed in 41.4 seconds**, with **0 unexpected failures, 0 flaky tests, and 0 skipped tests** in its JSON statistics.

| Layer            | Distinct cases | Execution model              | Passed executions |
| ---------------- | -------------- | ---------------------------- | ----------------- |
| API              | 38             | Once in `service`            | 38                |
| Contract         | 16             | Once in `service`            | 16                |
| UI               | 26             | Each of 3 browser engines    | 78                |
| Integration      | 3              | Each of 3 browser engines    | 9                 |
| Total Playwright | 83             | Service + 3 browser projects | 141               |
| Domain unit      | 31             | Node test runner             | 31                |

The project totals are service 54, Chromium 29, Firefox 29, and WebKit 29. Browser executions are counted separately from distinct scenarios; the 31 unit checks are not included in the 141 Playwright executions. These counts describe the recorded run, not a percentage of all possible domain behavior.

## Repetition, local CI, and final demonstrations

The coordinating agent executed and inspected these final checks. Intentional-failure exits were verified against their intended assertion and evidence, rather than treated as generic nonzero outcomes.

| Check                              | Exact command                                   | Recorded outcome                                                                                                            |
| ---------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Repeated parallel suite            | `npm test -- --repeat-each=2`                   | Exit 0; 282 passed in 80.250 seconds, 4 workers, 0 retries, 0 unexpected/flaky/skipped                                      |
| Local CI configuration             | Set `CI=true`, then `npm test`                  | Exit 0; 141 passed in 53.203 seconds, 2 workers / 1 allowed retry, 0 unexpected/flaky/skipped                               |
| Final intentional UI failure       | `npm run demo:failure`                          | Expected exit 1; actual NEW versus deliberate FILLED expectation; trace, screenshot, video, error context and HTML verified |
| Final intentional contract failure | `npm run demo:contract`                         | Expected exit 1; malformed HTTP 200 quantity rejected by AJV; trace, screenshot, video, error context and HTML verified     |
| Normal suite after demos           | `npm test`                                      | Exit 0; 141 passed in 41.284 seconds, 4 workers, 0 retries, 0 unexpected/flaky/skipped                                      |
| Final evidence commit / clean tree | `git log -1 --oneline` and `git status --short` | The final evidence commit follows this document; verify the tree after committing                                           |

Repeated-run evidence is `.local/repeated-results.json` and `.local/repeated-suite.log`; each project records `repeatEach: 2`. The CI configuration evidence is `.local/ci-simulation-results.json` and `.local/ci-simulation.log`; all four projects record one allowed retry. Both JSON reports show no unexpected failures, flaky tests, or skipped tests. These Windows runs exercise the configured concurrency/repetition policy, not a GitHub-hosted Linux runner.

The normal suite was run again after both final demonstrations. `.local/post-demo-normal-results.json` and `.local/post-demo-normal.log` record 141 expected passes, no unexpected/flaky/skipped results, four workers, and zero retries in 41.284 seconds. This separately verifies that intentional failures did not break or become part of the normal suite.

For a local CI configuration run on PowerShell, restore the previous environment value after execution:

```powershell
$tradeflowPreviousCI = $env:CI
$env:CI = 'true'
npm test
$tradeflowCIExit = $LASTEXITCODE
$env:CI = $tradeflowPreviousCI
Write-Output "Playwright exit: $tradeflowCIExit"
```

This configuration has `failOnFlakyTests` enabled, so a pass only after retry still fails the gate. In macOS/Linux shells, the equivalent configuration command is `CI=true npm test`; that platform execution is not claimed here.

## Adversarial review and demonstrated regressions

An independent static review found four material issues. A scoped second review found one related authentication-ownership residual. The fixes preserved the agreed wire rules, assertion strength, retries, and timeouts.

| Observed issue                                                                                                  | Correction                                                                                                                            | Evidence                                                                                  |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Earlier detail/cancellation responses could replace a newer selection or reopen closed details                  | Generation and captured session identity establish ownership; cancellation updates its own target without replacing a later selection | Controlled response gates in `tests/ui/lifecycle.spec.ts`                                 |
| Network, server, or malformed-response failures during restoration removed a valid token and access to its book | Preserve valid credentials on transient/contract failures; clear on actual 401 or sign-out                                            | Owned generated order survives a controlled failure and subsequent reload                 |
| A valid LIMIT price of `0.001` displayed as `0.00`                                                              | Display the accepted numeric value without cents rounding                                                                             | Exact `detail-limit-price` assertion for `0.001`                                          |
| A fixed-port performance smoke could sample an unrelated existing server                                        | Import and own the server on an OS-assigned loopback port, use its actual address, and close it                                       | Occupied port 3001 verification received 0 foreign requests                               |
| A delayed restoration 200/401 could overwrite or clear a newer viewer login                                     | Capture the token at restoration start and ignore stale success/error paths                                                           | Two controlled stale-restoration cases preserve the newer token, viewer identity and book |

The first lifecycle regression run before its fix recorded **9 failed / 1 passed** in Chromium. After the correction, `npx playwright test tests/ui/lifecycle.spec.ts` recorded **30 passed across three engines in 18.5 seconds**. The later stale-restoration red run recorded **2 failed / 1 passed**; its two new cases then recorded **6 passed across three engines in 7.4 seconds**. The final full gate includes all 12 lifecycle cases across all engines.

Relevant command/evidence records are `.local/review-fixes.md`, `.local/lifecycle-green.log`, `.local/restoration-race-red.log`, `.local/restoration-race-green.log`, and `.local/scoped-review.md`. The scoped reviewer inspected code and existing logs, and ran no tests or servers. Its final verdict found no outstanding material issue within the assigned review scope. That verdict is neither an exhaustive defect guarantee nor human acceptance.

Implementation issues also surfaced during early verification: Playwright serialized an invalid JSON string as valid quoted JSON, so the test now sends a raw Buffer while retaining its `INVALID_JSON` oracle; the independent contract helper needed reusable response-reference resolution; a cleanup throw violated lint and was replaced with explicit error reporting and a nonzero exit. Initial Windows sandbox process/cache restrictions required appropriately authorized browser/process execution. The subsequent recorded gates passed; no failing test was deleted, skipped, or weakened to conceal those issues.

## Performance smoke

`npm run perf:smoke` recorded **120 requests**, **concurrency 4**, **0 errors**, and **p95 5.25 ms**. It validates HTTP 200 bodies at runtime and requires p95 below the deliberately loose 250 ms threshold. An additional `npx tsx .local/perf-ownership-check.ts` run held a separate application server on port 3001: the smoke exited 0, that foreign server received **0 requests**, and smoke p95 was **4.70 ms**.

A final smoke run alongside normal tests also exited 0: 120 measured requests, concurrency four, zero errors, p95 8.59 ms, and a 164.72 ms measured burst. Both baseline and final latency remained below the 250 ms smoke threshold; the variation is a reminder that this is a local environment-sensitive observation.

The smoke owns an in-process application server on an ephemeral loopback port, deletes its session, and closes its server. These observations are a small local smoke signal, not enterprise load, soak, capacity, real-market, or production-latency evidence. The threshold is environment dependent and excluded from normal CI.

## Failure evidence and storage

Both final demos were re-executed after the review fixes and each exited 1 at its intended assertion. Each produced a PNG screenshot, WEBM video, trace ZIP, error context, and HTML report. The coordinating agent visually inspected the UI screenshot: selected `seed-new-aapl` details visibly show NEW, while the deliberate expectation is FILLED.

Decoded UI trace evidence includes 44 before-action events, 44 after-action events, 13 DOM snapshots, 8 screencast frames, and an actual orders response with HTTP 200 and NEW status. Decoded contract trace evidence includes 54 before/after-action events, 8 DOM snapshots, 9 screencast frames, and an actual orders response with HTTP 200 and quantity `"many"`; AJV rejects the integer contract. Archives are `.local/final-ui-demo-results/`, `.local/final-ui-demo-report/`, `.local/final-contract-demo-results/`, and `.local/final-contract-demo-report/`. These local archives are ignored by Git; rerun the explicit demos to regenerate evidence.

Normal generated output uses `test-results/` and `playwright-report/`. Demo output uses separate `demo-results/` and `demo-report/`; inspect or archive one demo before the other replaces its output. Normal traces capture the first retry, screenshots capture failures, and videos are retained on failure. Demos trace from the start. Local zero-retry failures need `--trace on` for a fresh trace reproduction.

The normal HTML report was served with `npm run report -- --host 127.0.0.1 --port 9323`. The final UI trace was served with `npx playwright show-trace demo-results/ui-evidence-intentional-UI-ceb94-wrong-lifecycle-expectation-failure-demo/trace.zip --host 127.0.0.1 --port 9325`. HTTP checks returned 200 for both the report and trace-viewer entry pages. Trace contents were inspected from the archive as described above; these HTTP checks establish viewer availability, not a separate browser interaction audit.

The workflow uploads normal HTML reports with 14-day retention and available failure evidence with 7-day retention. Workflow YAML/gate validation is recorded; upload behavior on an actual GitHub runner is not yet executed. Use `npm run report` or `npm run report:demo` for the appropriate report.

## Acceptance boundary

The application remains one local process with in-memory synthetic sessions/books, static positions, public fake credentials, and no real financial integrations. Session TTL, production identity, persistent audit/reconciliation, matching/fills, real price precision, and distributed resilience are not implemented. Agent-generated behavior and tests are prepared with reviewable diffs and executable evidence; **no human acceptance is recorded by this document**. The human acceptance decision remains distinct from green gates and agent review.
