# Public institutional workflow release

## Status and purpose

This revision adds an optional public synthetic workflow profile. Its source, isolated image verification and proposed release settings are separate from a public deployment. The existing application remains pinned to the independently released equities artifact until the owner approves a concrete new release. Merging source does not activate the profile or provision a database.

The target is an independently hosted TradeFlow URL: equities, two fictional fixed-income instruments, dealer RFQs, quotation acceptance, controlled execution/cancellation, an immutable execution ledger and historical reconciliation. FIX evidence remains application-message validation and offline session conformance; no FIX engine, socket, live market feed, broker, settlement or real financial transaction is introduced.

## Application and database boundaries

| Layer             | Contract                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public ingress    | Preserve existing Cloudflare HTTPS and separate Railway tunnel; application stays private behind that tunnel                                      |
| Application       | Existing hosted admission and session limits; explicit optional public workflow activation                                                        |
| Visitor ownership | One server-owned workspace intent per authenticated synthetic session; trader trade scope, viewer read scope                                      |
| Database          | Dedicated PostgreSQL 17.10 cluster/database with a branded optional profile; private network and strict CA/hostname TLS validation                |
| Roles             | Separate application, read-only reconciliation, migration and maintenance credentials; runtime cannot migrate, assume owner or change ledger rows |
| Cleanup           | Maintenance-only expiry purge, guarded database identity, finite capacity and explicit unavailable state on failure                               |

`TRADEFLOW_FIXED_INCOME_WORKFLOW=postgres` retains its original local-only loopback guard. Public activation uses separate settings and cannot be combined with that local setting. The eight base migration files/checksums, financial calculations and FIX contracts are unchanged. The optional profile and image SQL manifest are checked by `npm run workflow:validate`.

## Visitor flow and replay

Sign in with the published fake credentials, open Fixed-income analytics, and then open Dealer RFQ workstation. **Start private workspace** allocates a private synthetic sandbox without capability input. The browser retains only a session-bound idempotency key before requesting allocation; ownership material stays on the server. Unavailable storage stops the request before HTTP.

The server retains one exact intent/key before database dispatch. Concurrent starts return the same original result; a lost commit response is retried with the original intent. A different key cannot allocate another workspace for that session. Refreshing the browser reopens confirmed ownership. Native capability create/recover/rotate routes are unavailable publicly. Logout, original session expiry and application restart end access; no cross-session or cross-restart ownership recovery is offered.

**Proposed public-only lifetime:** writes end 30 minutes after workspace creation; records become eligible for cleanup after 60 minutes. Access ends at the original synthetic session expiry, which is at most 30 minutes from login and may be earlier than the workspace write deadline. Starting later does not extend the session. The 60 minutes is server-side record retention, not a promise of post-session read access. Cleanup may be delayed by protected active leases or infrastructure failure; it never reports success merely because an attempt occurred.

Capacity remains 50 retained workspaces with the existing command/event and request limits. Cleanup removes only eligible complete graphs. The public wrapper refuses any unmarked legacy sandbox and bounds public UUID retirement metadata. Legacy tombstones and the original seven-day write/thirty-day durable ownership policy remain unchanged. Adding public ownership recovery later would require reviewing the public UUID-retirement exception.

Equities and stateless analytics remain available when persistence fails. Financial workflow errors remain explicit; there is no in-memory financial fallback or fabricated empty success.

## Reproduce before release

Use the accepted Linux/WSL setup: Node 24, locked npm dependencies, Python 3, Docker and the three Playwright browsers/system libraries. OpenSSL is needed for the independent TLS test fixture. Run:

```sh
npm ci
npm run test:public-demo
```

The command builds a dedicated database image from the same digest-pinned PostgreSQL 17.10 base used by existing acceptance. It generates private disposable credentials, creates only uniquely labeled owned Docker resources, initializes the actual image, verifies branded schema/TLS/roles, runs the public API/database cases, runs Chromium/Firefox/WebKit, repeats those browser cases twice, and verifies cleanup. Test-only TCP routing points the private DNS identity at the owned local mapped port; certificate and hostname checks remain enabled. This is not evidence of a provider DNS/TLS deployment.

Test output identifies a private recovery descriptor and an evidence directory beneath ignored `.local/public-image-evidence-*`. Preserve logs, counts, failure artifacts and sanitized receipts. Generated passwords are checked for absence from logs. Only resources matching the invocation's ownership label are removed; no global Docker prune is used. If cleanup cannot establish ownership, it preserves the descriptor and reports failure. A hard kill or machine loss cannot guarantee cleanup; inspect ownership before any manual removal.

The mandatory workstation-baseline CI job includes this command. Its existing deadline, retries, permissions and aggregate remain unchanged. Omitting the public gate fails workflow validation. `npm run validate:all` also includes the public image gate. Historical 455-test and workstation counts remain attached to their own commands; public cases are counted separately.

## Concrete hosted configuration

Use the existing Railway project, a separately scoped rehearsal environment and one new dedicated database service. Do not clone or repurpose the production tunnel/token. Build the database with `deployment/postgres/Dockerfile`; mount its dedicated volume at `/var/lib/postgresql/data`. The image uses `/pgdata` and `/tls` beneath that mount, keeping the CA across restarts. Do not expose a database TCP proxy or mount its volume into the app.

Read the database's actual private hostname from provider metadata. From a clean reviewed source tree, prepare a new private configuration file before any role bootstrap:

```sh
node --import tsx scripts/public-demo-release-config.ts prepare \
  ACTUAL-DATABASE.railway.internal REVIEWED_SOURCE_SHA \
  .local/public-release/prepared.json
```

That command makes no provider/database call and never overwrites an existing journal. It generates five distinct credentials and a dedicated database name/nonce. Apply only the journal's database environment to the new, empty, approved database service. Keep all values private; never print or paste the journal into GitHub, browser state, evidence or chat.

After successful initialization, retrieve only the public CA with the service's `tradeflow-postgres export-ca` command through authenticated owner tooling. Never retrieve `root.key` or `server.key`. Retain the public CA as a file, then create a second private journal:

```sh
node --import tsx scripts/public-demo-release-config.ts bind-ca \
  .local/public-release/prepared.json /absolute/public-ca.pem \
  .local/public-release/ca-supplied.json
```

The CLI checks the reviewed source tree, preserves the first journal and validates the complete application profile. **CA_SUPPLIED means only that a valid public CA was supplied; it is not live TLS verification.** Read back service identity/hostname and positively/negatively verify the real provider connection before accepting a hosted release.

The application environment contains hosted mode, public activation, three role-specific URLs and the public CA. URLs have no query/hash TLS overrides. Private keys and administrator/migrator credentials never enter the application environment. Keep one app replica and the reviewed existing ingress/resource bounds. New database resource limits, volume size, billing and certificate operation must be reviewed with the release; they are not approved by source changes.

## Certificate and database operation

The image creates a private CA only for a new owned volume. Existing PGDATA without its identity/CA is rejected. A different database nonce, incorrect major version, shared role passwords or key mismatch fails closed. First initialization installs roles, all eight base migrations and the optional profile in one transaction; application startup performs no migration. A subsequent image does not reset existing roles/passwords or silently upgrade a schema. An incomplete initialization or incompatible revision requires owner investigation while preserving the volume.

The CA lasts ten years. Leaf certificates last 90 days and renew on database startup when fewer than 30 days remain, preserving the CA. Continuous uptime alone does not renew a leaf. Before production acceptance, the operating arrangement must include expiry monitoring and an owner-controlled renewal/restart before expiry. Do not promise unattended certificate renewal or high availability from this image. Confirm a real restart retains the CA, data and role access. Root-CA replacement is an explicit coordinated trust change.

## Release approval and acceptance

Before requesting release, require a clean exact revision, all existing local/hosted gates, the new image gate, one independent branch review and resolved material findings. The release review must explicitly accept the short public-only lifetime, new dedicated database/volume/credentials, resource cost, certificate operation and the exact application/database source.

Rehearse the provider topology without changing the current production app/tunnel. Verify actual PostgreSQL version, CA and hostname rejection, least-privilege roles, source checksums, readiness and controlled restart. Production cutover requires separate explicit owner approval. Afterwards verify the real URL with two independent synthetic visitors, exact pricing/execution values, viewer/cross-session denials, reconciliation, outage behavior, cleanup and deployed source. No release is accepted from a queued deployment or CI history alone.

Rollback restores both the previously reviewed hosted equities source and its exact previous application environment. Remove the entire newly added `TRADEFLOW_PUBLIC_DEMO*` variable set; merely setting activation to off is insufficient, and an older artifact rejects unknown namespaced settings. Preserve the new database/volume, private journals and evidence. No automatic schema downgrade, database deletion, password rotation or tunnel replacement is authorized by rollback documentation. Update the deployment receipt, current-state index, README and portfolio only from the actual observed release.
