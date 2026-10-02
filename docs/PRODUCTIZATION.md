# Productization evidence

This bounded pass began on clean `main` at `f7f2f108576fd5d940f4a9649519d24be9ecb778` and uses `codex/productization-pass`. The approved scope is a professional synthetic workstation around the existing test architecture. No server/domain/API contract, fixture lifetime, browser project, retry, or CI gate was changed. No merge or visibility change is part of this pass.

## Behavior and regressions

Overview derives full-book status counts and average-cost gross position notional. Orders retains server filters and exact-record actions. Positions stays static. Activity records the latest 50 browser-observed actions and clears on reload/logout/token replacement. Lifecycle projects only creation time and current state. The four-symbol quote table is a fixed client fixture. Viewer controls remain visible and disabled; API 403 checks remain authoritative.

The client also guards positions and complete-book reads by token/request version, invalidates pre-mutation book reads, clears ticket drafts between sessions, and reports a failed logout request as no response rather than pending. A current-session protected API response with 401 clears authentication and explains the reason; a stale 401 cannot replace a newer login. Accepted creation/cancellation observations survive a later refresh error. Unknown metrics remain unavailable rather than fabricated zeroes.

Three added unit checks cover lifecycle partitions and mutation changes, a valid empty book, and signed-quantity average-cost notional. Seven added UI scenarios cover keyboard/responsive navigation, filter-independent metrics and actions, fixed quotes, viewer presentation, same-session stale reads, prior-session book/positions/draft isolation, and unavailable first reads. Existing scenarios gained reload-activity, validation-activity, accepted-mutation/failed-refresh, and failed-logout oracles. Assertions on exact IDs, HTTP statuses/bodies, complete books, and session ownership were retained.

## Local execution

Windows, Node `24.19.0`, npm `11.19.1`, Playwright `1.63.0`; four normal workers and zero retries. Counts were independently read from Playwright JSON, not copied from documentation.

| Command                       | Inspected result                                                           |
| ----------------------------- | -------------------------------------------------------------------------- |
| `npm run typecheck`           | Exit 0 after correcting browser Fetch status-property usage                |
| `npm run lint`                | Exit 0, zero warnings                                                      |
| `npm run format:check`        | Exit 0                                                                     |
| `npm run contract:validate`   | Exit 0; OpenAPI 1.0.0 valid                                                |
| `npm run workflow:validate`   | Exit 0; structure only, not hosted evidence                                |
| `npm run test:unit`           | Exit 0; 34 passed, zero failed/skipped                                     |
| `npm test`                    | Exit 0; final combined gate: 205 passed in 60.186 seconds                  |
| `npm test -- --repeat-each=2` | Exit 0; final unchanged suite: 410 passed in 122.370 seconds               |
| `npm run demo:failure`        | Expected exit 1; actual NEW differs from deliberately expected FILLED      |
| `npm run demo:contract`       | Expected exit 1; HTTP 200 body quantity `many` rejected by Zod/AJV and UI  |
| `npm run perf:smoke`          | Exit 0; 120 requests, concurrency 4, zero errors, p95 12.7 ms below 250 ms |
| `npm run validate`            | Exit 0; all static/specification gates, 34 units, and 205 executions       |

Normal and repeated JSON contain zero unexpected, flaky, skipped, or retried executions and no top-level errors. Arithmetic: `42 API + 22 contract + (44 UI × 3) + (3 integration × 3) = 205`; repeat-each 2 gives `410`. Each browser performs `44 + 3 = 47` executions normally and 94 when repeated. Unit count is `31 + 3 = 34`.

An initial final-repeat attempt inside the agent process sandbox stalled at Firefox launch and was stopped with exit 1. An isolated 10-second Firefox launch probe timed out inside that sandbox; the identical probe succeeded outside it. The unchanged full repeat then passed outside the sandbox. This is an execution-environment limitation, not a test retry or repository workaround; the aborted run is not counted as passing evidence.

Both demo HTML payloads independently contain one intentional unexpected result, with screenshot, video, error context, and trace attachments. Actual ZIP network records include the malformed HTTP 200 response with string quantity `many`. Demo output remains separate from normal reports. The optional performance number is a local environment-sensitive signal, not a trading-capacity claim. Expected RED tests exposed missing behavior, stale ticket drafts, and the logout-footer defect before their fixes; an initial typecheck caught Fetch/Playwright status API confusion.

## Actual visual evidence

Chromium `153.0.8010.12` captures were generated from the running local application on 2026-10-02. All four views were exercised at 1440/1024/768; a thirteenth layout included a created UUID, maximum quantity, and LIMIT price 0.001 at 768. No document/table overflow or console errors were observed. Images were visually inspected; this is not a WCAG certification or pixel-baseline test.

Committed captures: [overview 1440](screenshots/tradeflow-overview-1440.png), [orders/details 1440](screenshots/tradeflow-orders-1440.png), [created order 768](screenshots/tradeflow-orders-768.png), [viewer 1024](screenshots/tradeflow-viewer-1024.png), [positions 1024](screenshots/tradeflow-positions-1024.png), and [activity 1024](screenshots/tradeflow-activity-1024.png). These are actual renders with synthetic data, not mockups.

## Review and public readiness

Four perspectives were reviewed: fintech manager (financial/data claims), principal SDET (ownership and independent oracles), Playwright expert (fixtures/races/browser coverage), and portfolio reviewer (visual credibility, evidence/provenance, scope). No further material issue remained in the reviewed implementation after the regressions above. This does not replace human review of the concrete diff.

A bounded scan of the 16 reachable baseline commits / 94 tracked blobs found no known secret, private-key, token, credential-URL, private-path, or machine/artifact-path signatures. A second current-source scan also found none. No employer/proprietary material was found in the reviewed synthetic content. These checks are bounded pattern/content reviews, not guarantees. The ignore rules exclude generated bundles/reports, browser auth, environment files, logs, and local evidence. `private: true` remains an npm publishing guard. No project license has been selected; only the owner can resolve that before open-source reuse. Dependency licenses do not establish the project's license.

Sorting, charting, P&L, live feeds, historical performance, advanced orders, durable activity, new backend endpoints, persistence, and a SPA framework were deliberately omitted. Positions do not change after order entry. Full-book cache freshness follows accepted reads and this browser's mutations; another client sharing the token requires reload/unfiltered refresh. Activity is browser owned and bounded. Sub-700px layouts are secondary; automated accessibility certification and macOS execution are not established.

## Hosted execution

Pending exact-SHA push-triggered validation. Historical baseline/audit runs do not validate this pass. HTML retention remains 14 days; conditional failure evidence remains 7 days. A green run that skips the failure upload does not prove hosted failure-upload behavior.
