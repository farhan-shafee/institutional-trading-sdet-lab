# CI/CD and quality gates

> Current milestone/release map: [CURRENT_STATE.md](CURRENT_STATE.md). Later accepted local/CI source and the separately pinned public demo have different scopes.

Read `.github/workflows/quality.yml` with `package.json` and `playwright.config.ts`. The workflow expresses a quality gate for a synthetic lab; it validates the synthetic lab and does not deploy real trading infrastructure. Public hosting uses Railway and Cloudflare Tunnel with a pinned application release; CI success alone does not change that source pin. See [current production deployment](RAILWAY_PRODUCTION.md). Review the [validation record](VALIDATION.md) to distinguish local execution from an actual hosted Actions run.

## Both mandatory workflows

`quality.yml` runs full audits/static checks, independent financial/FIX verification, native artifact smoke, and normal/repeated legacy browser tests. `persistence.yml` runs two fresh PostgreSQL executions, baseline/repeated three-browser RFQ workstation checks, their mandatory aggregates, and a full legacy regression job. The eight main job names are `quality`, `postgres-run-a`, `postgres-run-b`, `postgres`, `workstation-baseline`, `workstation-repeat`, `workstation`, and `regression`.

In this revision, workstation-baseline additionally requires `npm run test:public-demo`: build the dedicated PostgreSQL 17.10/TLS image, verify ownership/role/transport/failure boundaries, run normal and repeated Chromium/Firefox/WebKit public-workflow cases, and check owned resource cleanup and credential absence from logs. The existing job deadline, permissions, retry settings and aggregate are preserved. Strict workflow validation rejects omission of this gate. See [the public release contract](PUBLIC_WORKFLOW.md); a green local image is not a provider deployment.

The accepted checkpoint's exact counts and links are in [CURRENT_STATE.md](CURRENT_STATE.md). PostgreSQL/workstation tests use zero test retries; 30-second tests and 15-minute jobs remain unchanged. The legacy Playwright diagnostic retry still fails the gate for flaky results. Missing/skipped/cancelled mandatory executions are not accepted. Both workflows must be complete; a green aggregate is not a substitute for inspecting its required executions.

## Pipeline

1. Check out the repository and configure Node 24.
2. Cache npm's download cache using the lockfile, then install reproducibly with `npm ci`.
3. Require `npm audit` and `npm audit --omit=dev` to succeed without audit-level exclusions, conditional execution or ignored failures.
4. Run strict type checking, lint, formatting, OpenAPI-document validation, workflow YAML/gate validation, and domain checks, then build and smoke-test a clean production-only artifact.
5. Install Chromium, Firefox, and WebKit with the OS dependencies needed by the Linux runner.
6. Run the normal Playwright projects against the local server.
7. Upload the HTML report with finite retention, including after a test failure.
8. Upload available failure evidence from `test-results/` when the job fails.

The locked dependency graph is reviewed source, not a promise that third-party packages can never have defects. Browser installation and npm caching solve different problems; caching npm does not install the browser binaries or Linux libraries.

## Concurrency and failures

CI uses two workers and one diagnostic retry. `failOnFlakyTests` makes a test that passes only after retry fail the quality gate. Local execution uses four workers and zero retries. `fullyParallel` is justified by per-test session-owned books, rather than by a job that resets a shared database.

The server's health check controls readiness before tests execute. Unit checks and API/contract tests provide fast feedback before interpreting an expensive browser failure. Every async step must exit nonzero on failure; a report is evidence, not permission to ignore the failed job.

## Artifact policy

Normal authenticated suites disable traces to exclude bearer headers and browser auth state. The RFQ browser gate additionally disables screenshots/video and uploads no browser artifacts. Assertions, normal project coverage, diagnostic retry counts and fail-on-flaky behavior are preserved.

| Artifact           | When                                            | Retention              | Contents                                                                         |
| ------------------ | ----------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| Normal HTML report | After normal test execution, including failures | 14 days                | Test results, projects, screenshots and video links                              |
| Failure evidence   | On job failure, if files exist                  | 7 days                 | Failed screenshots, retained videos, result attachments; no authenticated traces |
| Demo reports       | Local explicit demo only                        | Local generated output | Intentional failure evidence excluded from the CI gate                           |

Normal authenticated suites keep traces off, screenshots only on failure and video retained only on failure; the RFQ gate disables screenshots/video too. Intentional demo traces remain separate. Artifacts may be absent if installation or an earlier static gate failed before any browser test. GitHub's [artifact documentation](https://docs.github.com/en/actions/tutorials/store-and-share-data) explains upload/download and finite retention.

## Local equivalents

```sh
npm ci
npm run browsers:install
npm run typecheck
npm run lint
npm run validate
npm test -- --repeat-each=2
```

On a fresh Linux CI machine, Playwright browser installation includes system dependencies; a desktop installation usually does not need that option. `validate` is the complete local gate, including both dependency audits and normal Playwright tests. Audit results depend on the registry advisory database at execution time; a registry failure also fails the gate. See [the October 25 maintenance record](SECURITY_MAINTENANCE_2026-10-25.md). Stop a manual app before running it; the tests own port 3000. `workflow:validate` parses YAML and verifies the expected gate/artifact structure; it does not establish that GitHub accepted or executed the job. Intentional demos and the environment-sensitive performance smoke remain outside it.

## Review questions

Can the job fail while artifacts still upload? Are report names and retention finite? Can a retry hide a flaky result? Does the workflow require unnecessary secrets or write privileges? Does every action of the workflow have a clear equivalent in package scripts? Changes to workflows and assertions deserve the same human review as application behavior.
