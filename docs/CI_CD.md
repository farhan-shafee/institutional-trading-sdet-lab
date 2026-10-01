# CI/CD and quality gates

Read `.github/workflows/quality.yml` with `package.json` and `playwright.config.ts`. The workflow expresses a quality gate for a synthetic lab; it does not deploy trading infrastructure. Review the [validation record](VALIDATION.md) to distinguish local execution from an actual hosted Actions run.

## Pipeline

1. Check out the repository and configure Node 24.
2. Cache npm's download cache using the lockfile, then install reproducibly with `npm ci`.
3. Run strict type checking, lint, formatting, OpenAPI-document validation, workflow YAML/gate validation, and domain checks.
4. Install Chromium, Firefox, and WebKit with the OS dependencies needed by the Linux runner.
5. Run the normal Playwright projects against the local server.
6. Upload the HTML report with finite retention, including after a test failure.
7. Upload available failure evidence from `test-results/` when the job fails.

The locked dependency graph is reviewed source, not a promise that third-party packages can never have defects. Browser installation and npm caching solve different problems; caching npm does not install the browser binaries or Linux libraries.

## Concurrency and failures

CI uses two workers and one diagnostic retry. `failOnFlakyTests` makes a test that passes only after retry fail the quality gate. Local execution uses four workers and zero retries. `fullyParallel` is justified by per-test session-owned books, rather than by a job that resets a shared database.

The server's health check controls readiness before tests execute. Unit checks and API/contract tests provide fast feedback before interpreting an expensive browser failure. Every async step must exit nonzero on failure; a report is evidence, not permission to ignore the failed job.

## Artifact policy

| Artifact           | When                                            | Retention              | Contents                                                                 |
| ------------------ | ----------------------------------------------- | ---------------------- | ------------------------------------------------------------------------ |
| Normal HTML report | After normal test execution, including failures | 14 days                | Test results, projects, attachments and trace links                      |
| Failure evidence   | On job failure, if files exist                  | 7 days                 | Traces on retry, failed screenshots, retained videos, result attachments |
| Demo reports       | Local explicit demo only                        | Local generated output | Intentional failure evidence excluded from the CI gate                   |

The configuration limits routine evidence: trace on first retry, screenshot only on failure, video retained on failure. Artifacts may be absent if installation or an earlier static gate failed before any browser test. GitHub's [artifact documentation](https://docs.github.com/en/actions/tutorials/store-and-share-data) explains upload/download and finite retention.

## Local equivalents

```sh
npm ci
npm run browsers:install
npm run typecheck
npm run lint
npm run validate
npm test -- --repeat-each=2
```

On a fresh Linux CI machine, Playwright browser installation includes system dependencies; a desktop installation usually does not need that option. `validate` is the complete local gate, including normal Playwright tests. Stop a manual app before running it; the tests own port 3000. `workflow:validate` parses YAML and verifies the expected gate/artifact structure; it does not establish that GitHub accepted or executed the job. Intentional demos and the environment-sensitive performance smoke remain outside it.

## Review questions

Can the job fail while artifacts still upload? Are report names and retention finite? Can a retry hide a flaky result? Does the workflow require unnecessary secrets or write privileges? Does every action of the workflow have a clear equivalent in package scripts? Changes to workflows and assertions deserve the same human review as application behavior.
