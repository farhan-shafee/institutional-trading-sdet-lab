# TradeFlow public-demo deployment readiness

Proposed URL: `https://tradeflow.farhan-shafee.com`. This is a readiness branch, not a deployed service. No hosting project, domain attachment, DNS record, billing feature, or paid infrastructure is authorized by this work. Main remains the approved portfolio baseline until owner review.

## Architecture and implementation boundary

Use one dedicated Railway Node.js 24 service, one replica, one region, and no database or volume. The same native HTTP application serves the browser bundle, API, health endpoint, and OpenAPI. Cloudflare remains the DNS provider. Railway is suitable because this application needs a long-running Node process with process-local session books; moving it into serverless functions would change that model. [Railway networking requirements](https://docs.railway.com/networking/troubleshooting/application-failed-to-respond) require a public listener on `0.0.0.0` and the platform `PORT`.

Each login still clones its own five-order book. Hosted mode adds admission and lifetime boundaries, not trading functionality. No real identity provider, exchange, brokerage, live prices, fills, P&L, customer data, or employer systems exist. Credentials, orders, positions, and quotes are synthetic. Books are ephemeral and disappear on logout, expiration, process restart, replacement, or sleep/wake that replaces a process.

The implementation keeps resource ownership small: configuration validates the profile; `SessionStore` owns expiry/capacity and per-session mutation budgets; `OrderBook` owns record capacity; three fixed-size admission counters belong to the server. Existing Page Objects, test-scoped sessions, in-memory storageState, runtime schemas, and three-browser coverage remain.

## Build and runtime

Use Node 24 with the lockfile. A build stage must include development tools:

```sh
npm ci --include=dev
npm run build
```

The artifact is `dist/app/server/index.js`, `dist/app/public/{index.html,style.css,app.js}`, and `dist/contracts/openapi.yaml`. Browser/server bundles use the existing esbuild dependency. The runtime retains only `package.json`, `package-lock.json`, `dist/`, and production dependencies from `npm ci --omit=dev`. No tsx, esbuild, Playwright, TypeScript source, source maps, or local authentication state is required at runtime. Runtime files resolve relative to the entry module, including when launched from another working directory.

The future Railway start command should be direct Node, so signals reach the application:

```sh
node dist/app/server/index.js
```

`npm run start:production` runs that same entry locally. `npm start` deliberately retains the existing loopback development build/start workflow. `npm run smoke:production` creates a separate temporary runtime outside the checkout, installs only locked production dependencies, verifies that only zod is installed, and starts native Node child processes on loopback from an unrelated working directory. The QA driver uses checkout development tools; the application children cannot depend on them. Temporary runtime files are removed after verification. Do not start an artifact after a failed build. Missing assets, invalid configuration, and listen failures must exit nonzero with safe diagnostics.

## Explicit configuration

No values have been set in Railway. These are the proposed application settings:

| Variable                                 | Hosted default                                  | Accepted values / purpose                                                                                     |
| ---------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `TRADEFLOW_MODE`                         | `local` when absent                             | Exact `hosted-demo` is required for external binding and demo limits; `local` preserves the deterministic lab |
| `TRADEFLOW_HOST`                         | `0.0.0.0` in hosted mode; otherwise `127.0.0.1` | Only these two addresses; loopback override is used for all readiness smoke traffic                           |
| `PORT`                                   | `3000` locally                                  | Railway injects its port; integer 1–65535                                                                     |
| `TRADEFLOW_SESSION_TTL_SECONDS`          | `1800`                                          | 1–3600; absolute lifetime, never extended by requests                                                         |
| `TRADEFLOW_MAX_SESSIONS`                 | `50`                                            | 1–100 active sessions                                                                                         |
| `TRADEFLOW_MAX_ORDERS_PER_SESSION`       | `100`                                           | 5–200 total records, including seeds and terminal orders                                                      |
| `TRADEFLOW_REQUESTS_PER_MINUTE`          | `600`                                           | 1–1200 requests across this process                                                                           |
| `TRADEFLOW_AUTH_PER_MINUTE`              | `60`                                            | 1–120 session-creation attempts, including rejected credentials/JSON                                          |
| `TRADEFLOW_MUTATIONS_PER_MINUTE`         | `120`                                           | 1–240 admitted trader mutation attempts across this process                                                   |
| `TRADEFLOW_SESSION_MUTATIONS_PER_MINUTE` | `30`                                            | 1–60 trader mutation attempts per session                                                                     |

For a future Railway service, explicitly set `TRADEFLOW_MODE=hosted-demo`, `TRADEFLOW_HOST=0.0.0.0`, and pin Node 24 in the build environment; retain the finite defaults unless the owner reviews a change. `PORT` is platform-supplied. Generic `HOST`, `HOSTNAME`, and `NODE_ENV` never enable public listening. Invalid/unknown `TRADEFLOW_*` names, invalid numeric values, external binding in local mode, or hosted-limit settings in local mode fail closed. Local Playwright startup explicitly selects local mode and loopback; clear hosted-limit variables before running local commands rather than relying on a hidden CI bypass.

## Resource and HTTP boundaries

- Default maximum order records in the active session store: `50 × 100 = 5,000`, including all seeds; hard configuration ceilings allow at most `100 × 200 = 20,000`. Canceled orders still count. Capacity errors never evict another visitor's active book. These are record caps, not a byte-exact heap promise: pending requests/buffers and garbage collection add transient memory, bounded separately by connection and receive limits.
- Expiry is checked on authentication/login and swept every 30 seconds while idle. Expired tokens return `401 UNAUTHORIZED`; logout releases capacity immediately. A mutation body arriving after expiry/revocation must reauthenticate before changing state.
- Full session capacity returns `503 SESSION_CAPACITY_REACHED`; full order capacity returns `409 ORDER_CAPACITY_REACHED`. Cancellation remains available at the order cap. Neither capacity response promises a retry interval.
- Admission uses fixed 60-second windows and constant-size counters; no IP/forwarded-header maps. Exceeding a budget returns `429 RATE_LIMITED` with integer `Retry-After` seconds. Rejected attempts do not slide the reset time. A fixed window permits a boundary burst; these are demo admission controls, not a distributed anti-abuse system.
- `GET /health` and `DELETE /api/session` bypass admission budgets so readiness and cleanup remain usable. Global request admission runs before URL parsing/authentication and can return `429` first, including for malformed targets. Within that budget, missing/expired/revoked bearer tokens return `401`, and authenticated viewer mutations return `403` before mutation admission. Login admission runs before body parsing. No credentials grant access to another session's book.
- JSON bodies remain limited to 16,384 bytes (`413`); media type and JSON/schema errors stay explicit. Oversized or unread bodies close their connection after the response. Headers, connection count, requests per socket, receiver/inactivity timeouts, and keep-alive lifetime are bounded. Native HTTP 408/431/socket-admission failures may close a connection or use a native response rather than the API JSON envelope.
- Hosted transport bounds are 128 connections, 8 KiB total header bytes, 64 retained header entries, and 100 requests per socket. Request/inactivity timeouts are ten seconds; headers/keep-alive are five seconds, with one-second timeout checks. These are finite transport guards, not an exact wall-clock or bandwidth guarantee.
- Existing no-store, CSP, nosniff, and frame-denial headers remain. Unexpected errors log a fixed event without raw exceptions, bodies, URLs, headers, bearer tokens, or stack traces. Platform/proxy access-log retention and redaction still need owner review. Never put bearer tokens in query strings.

## Health, shutdown, and restart

Configure `/health` on the injected `PORT`; preserve exact HTTP 200 `{status:"ok",service:"TradeFlow Lab",synthetic:true}`. No authentication or token appears in health. Railway uses [deployment healthchecks](https://docs.railway.com/deployments/healthchecks) to decide readiness, not continuous application monitoring. Do not add a host allowlist that blocks its healthcheck host.

SIGTERM/SIGINT stops accepting new connections, closes idle connections, clears session resources after close, and force-closes remaining connections after five seconds. Configure a future draining interval of at least ten seconds (`RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, subject to provider support). [Railway teardown](https://docs.railway.com/deployments/deployment-teardown) sends SIGTERM before SIGKILL according to its draining configuration. Windows forced child termination is not proof of graceful signal handling; the Ubuntu smoke gate must exercise SIGTERM.

[Railway scaling](https://docs.railway.com/deployments/scaling) distributes replica traffic without sticky sessions. Use one replica and one region. Even replacement overlap can route visitors to different books/processes; there is no session-continuity or zero-downtime-state promise. Disable unreviewed autoscaling and consider disabling sleeping for predictable interview access. Deployments/restarts require a fresh sign-in. Review a bounded on-failure restart policy to avoid restart loops.

## DNS, HTTPS, and edge protections — later approval only

After separate owner approval, attach only `tradeflow.farhan-shafee.com` to the dedicated service. Obtain the exact CNAME target and any ownership TXT record from Railway; do not guess them. Add only the specific records requested by the provider in Cloudflare. Do not modify nameservers, the apex, or AegisGraph/CreditOps/portfolio records. Provider domain verification and certificate issuance must complete before announcing the URL. See [Railway public networking](https://docs.railway.com/networking/public-networking).

Prefer Cloudflare proxying when compatible with Railway domain verification and certificate renewal; confirm the current provider-specific procedure before changing DNS-only/proxied state. Use Railway HTTPS at the origin and Cloudflare [Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/) when proxied. Do not use Flexible SSL or disable certificate validation. Redirect public HTTP to HTTPS at the edge and keep HTTPS API/browser traffic same-origin. TLS terminates at the platform edge; the process speaks internal HTTP.

Keep `/api/*` and `/health` uncached, honoring the application's `Cache-Control: no-store`; do not apply a cache-everything rule that could share authenticated responses between visitors.

Add narrowly scoped Cloudflare WAF/rate rules for this hostname: tighter login attempts per verified client IP, overall API/mutation traffic controls, and managed DDoS protection. [Rate-rule features depend on the Cloudflare plan](https://developers.cloudflare.com/waf/rate-limiting-rules/); inspect existing entitlements and obtain approval before any paid upgrade. The application ignores `X-Forwarded-For` and does not treat socket peers, public credentials, or forwarded headers as authenticated visitor identity. Per-client edge controls require a verified proxy chain and a plan to prevent direct Railway-origin bypass. A discoverable origin can bypass Cloudflare protections unless restricted; if the provider cannot enforce the intended origin policy, record that limitation or keep the demo unavailable.

Application caps bound retained data and admitted work; they do not prevent connection floods, bandwidth bills, global quota starvation, or distributed attacks. One visitor can consume shared quotas. Health/logout remain inexpensive but are intentionally not application-rate-limited; edge protection and platform resource/spend controls are still required. No CAPTCHA, real auth, or claim of production financial security is introduced.

## Capacity and cost considerations

Start planning around one small Node process with approximately 256–512 MiB RAM and a modest CPU allocation, then measure actual idle/peak RSS and response behavior under bounded demo traffic. This is an engineering estimate, not a reservation or capacity benchmark. Limit service memory/CPU, restart behavior, log retention, egress, and spending before publication. No database or volume is needed.

Railway charges according to its current plan and resource usage; [pricing/plans](https://docs.railway.com/pricing/plans) and [cost controls](https://docs.railway.com/pricing/cost-control) must be reviewed by the owner at approval time. Hard usage limits are workspace-wide and can stop unrelated workloads; a dedicated service does not isolate that control. Review workspace impact before setting any hard limit, especially where other portfolio services share a workspace. A small demo is not a guaranteed fixed monthly bill: actual runtime, traffic/egress, build usage, sleep policy, and any Cloudflare paid features remain unknown. No plan, charge, or credit has been activated in this task.

## Rollback and post-deployment review

The approved public portfolio main baseline is `dc8ac09d5eea4f1a51b0cc32248d7a205fc67221`; it is loopback-only and must not be exposed as an unrestricted public fallback. If readiness changes are rejected, leave this branch unmerged. After an authorized deployment, disable public access first if a security boundary fails, then restore a previously reviewed hosted-safe artifact/configuration through provider deployment history. Rebuild from its exact SHA if no retained image exists. Do not reset or force-push Git history. Restarts/rollback lose all synthetic sessions and books; there is no data migration to recover.

Before enabling traffic, the owner must approve the code/tests, merge decision, dedicated Railway service and budget, domain attachment, specific Cloudflare records, TLS/proxy chain, edge controls/origin bypass policy, resource/restart/draining limits, and availability expectations.

Post-deployment checklist (not executed in this readiness phase):

1. Confirm DNS ownership, valid HTTPS certificate/redirect, correct hostname and no changes to unrelated services.
2. Verify synthetic public-demo labels, expiry/reset notice, public fake credentials, and no local-only or live-trading claims.
3. Check health/assets/OpenAPI; sign in as `qa.user` / `Password123!`, read the five seed orders, create and cancel an exact owned order, and reject FILLED cancellation.
4. Sign in separately as `qa.viewer` / `Password123!`; verify readable books and server-enforced 403 mutations. Verify missing/invalid tokens receive 401.
5. Test logout/revocation, session expiry/replacement isolation, resource caps, 429/Retry-After recovery, body limits, and edge/origin behavior without generating abusive traffic.
6. Exercise controlled restart/drain, confirm fresh-login behavior, inspect logs for token leakage, verify spend/resource alerts, and document the exact deployed SHA and observed outcomes.

## Observed readiness evidence

Starting main was clean and synchronized at `dc8ac09d5eea4f1a51b0cc32248d7a205fc67221`. Fresh baseline validation passed 34 unit checks and `42 API + 22 contract + 3 × (44 UI + 3 integration) = 205` Playwright executions, with zero failed/flaky/skipped/retried executions.

Local Windows readiness validation, before the focused commits:

| Check                         | Actual result                                                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run validate`            | Exit 0; TypeScript, lint, formatting, OpenAPI, workflow, units, build, production-only smoke, and complete Playwright suite passed                                                                                                                            |
| Unit checks                   | 54 passed: original 34 + 5 configuration + 15 resource-boundary checks                                                                                                                                                                                        |
| Normal Playwright             | 211 passed: 42 API + 22 contract + 6 hosted-boundary + 132 UI + 9 integration; 47 per browser                                                                                                                                                                 |
| `npm test -- --repeat-each=2` | Exit 0; 422 passed, including 12 hosted-boundary executions; 94 per browser                                                                                                                                                                                   |
| Outcomes                      | Zero failed, flaky, skipped, or retried executions in both final normal/repeated runs                                                                                                                                                                         |
| Clean source installation     | A separate source-only temporary copy, without node_modules/dist/local state, passed `npm ci --include=dev`, build, and production-only smoke                                                                                                                 |
| Native artifact smoke         | Fresh `npm ci --omit=dev` outside checkout contained only zod; assets, health, login/reads/create/cancel, FILLED conflict, viewer 403, logout/revocation, real expiry/replacement, capacity, auth admission/forwarded-header spoofing, and log hygiene passed |
| Startup failures              | Invalid PORT, missing runtime asset, and occupied loopback port each exited 1 with a safe diagnostic; the missing asset was restored                                                                                                                          |
| Browser inspection            | Actual built hosted-mode login/disclosure, five seed orders, Overview, and logout worked over loopback; no document overflow in the inspected view; capture remains untracked                                                                                 |

The domain/configuration and hosted HTTP regressions were observed failing before their respective implementation. Independent review found and corrected malformed-request-target admission/log bypass, clarified global-429 precedence over auth responses, and documented workspace-wide spending-limit impact. No assertions, retries, browser projects, or existing scenarios were weakened.

Windows smoke termination is forced and is not graceful-SIGTERM evidence. The Ubuntu workflow adds a native unfinished-body shutdown probe: await `100 Continue`, send SIGTERM, allow the application drain window, then require clean process exit within the bound. Exact-SHA GitHub Actions results and artifacts are the separate hosted evidence; use [readiness-branch runs](https://github.com/farhan-shafee/institutional-trading-sdet-lab/actions/workflows/quality.yml?query=branch%3Acodex%2Ftradeflow-deployment-readiness). Neither local nor GitHub Actions validation proves Railway provisioning, deployed TLS/DNS, continuous availability, edge/origin policy, or a production trading capability.
