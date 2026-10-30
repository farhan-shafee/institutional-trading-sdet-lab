# Phase 2A persistence and ownership foundation

This candidate adds persistent synthetic bond **sandbox ownership**, not bond trading. RFQs, dealer quotations, orders, executions, positions, FIX and settlement remain unimplemented. The existing equity lab and Phase 1 analytics retain their current behavior. Nothing in this milestone deploys to Railway or changes Cloudflare.

## Enablement and isolation

`TRADEFLOW_FIXED_INCOME_WORKFLOW` defaults to `off`. Off does not parse or connect to `TRADEFLOW_FIXED_INCOME_DATABASE_URL`; no PostgreSQL server is needed for existing development, production smoke or browser tests. With `postgres`, configuration requires local mode, loopback binding, a `127.0.0.1` PostgreSQL URL using `tf_app`, and a database named `tradeflow_local_<16 lowercase hex>` or `tradeflow_ci_<16 lowercase hex>`. Hosted activation, URL query options, alternate roles and external targets are rejected. This is local/CI infrastructure, not public durable identity.

Equity `SessionStore` remains in memory. Every login creates its original fresh cloned equity book. Bond ownership is independent of the public synthetic username. A valid existing trader/viewer session plus an explicit sandbox binding authorizes the new routes. Logout revokes that binding; restart discards all sessions/bindings, while PostgreSQL retains sandbox records.

Workflow-only contexts are bounded at 50 with an absolute 1,800-second lifetime; requests do not extend it. Existing local equity tokens do not acquire a new TTL. New workflow admission is 600 requests/minute, 120 mutations/minute globally and 30/session/minute, with 60 recovery/bootstrap proof attempts/minute globally and 10/context/minute. Status does not allocate a binding. Expired contexts are reclaimed on access; logout and shutdown remove them. Existing hosted admission remains unchanged.

Rotation invalidates only the binding. It preserves that session's original context actor, expiry and admission windows; recovery after rotation cannot reset those limits.

## Private client journal and uncertain responses

The supported foundation client is a POSIX CLI, avoiding browser secret storage and secret-bearing browser traces. It requires an owned private file, no symlink/hardlink indirection, no group/other access, a non-writable-by-others parent, and a real directory. Files inside the checkout must be under ignored `.local/`.

Before creation, the client generates a random sandbox UUID, distinct 32-byte read/trade capabilities and an idempotency key. It exclusively writes a mode-0600 journal, fsyncs the file and containing directory, and only then sends requests. Rotation likewise retains the old trade capability, new capabilities, expected generation and original key before sending the rotation. Existing journals are never regenerated or overwritten by retry. Diagnostic assertions compare hashes/booleans rather than printing journal contents.

```sh
npm run sandbox:client -- create --journal .local/ownership/create.json --base-url http://127.0.0.1:3000
npm run sandbox:client -- rotate --source .local/ownership/create.json --journal .local/ownership/rotate-1.json --base-url http://127.0.0.1:3000
```

Repeat the exact command/journal after a failed or lost response. A rotation retry first recovers with the retained NEW capability; if that generation never committed, it can recover with the retained previous capability and submit the original operation. A committed operation replays its original response without another generation increment. After a confirmed rotation, the latest rotation journal is the source for subsequent rotation. Do not use an obsolete creation journal as current ownership after keys have changed.

An existing journal is also fsynced, along with its containing directory and ancestors on the same filesystem, before reuse. Complete JSON left by an interrupted or failed preparation is not treated as proof of durability. File/directory sync failure prevents submission. This is a declared filesystem durability protocol, not a physical power-loss certification.

The client uses direct loopback HTTP, no redirects or ambient HTTP proxy routing, and creates/revokes its own synthetic login. Output contains only confirmation, sandbox ID and replay status. It never prints capabilities, bearer tokens or database URLs. Direct API callers must provide equivalent pre-submission retention; the server cannot force a client to save secrets. POSIX private-file tooling is required on Linux/WSL; Windows browser/legacy gates remain supported, but Windows ACL-based ownership journaling is not claimed.

## Database model and roles

Two additive, checksummed migrations create:

- `fi.sandboxes`: immutable identity/lifetime plus generation, commit sequence and bounded counts.
- `fi.commands`: immutable completed idempotency receipts, unique on sandbox/key and sandbox/command sequence.
- `fi.audit_events`: immutable typed creation/rotation/rejection events, composite references to their commands, unique aggregate generations.
- `fi.instrument_versions`: the two frozen Phase 1 reference definitions and exact source identity; no new financial calculations.
- `fi_control.sandbox_access`: domain-separated SHA-256 capability digests, never plaintext capabilities.
- `fi_control.service_capacity`: serialized retained-record capacity counter.
- `fi_control.purged_sandboxes`: UUID/purge-time tombstones preventing an old bootstrap replay from recreating a purged sandbox.
- `fi_control.schema_migrations` and `compatibility`: schema checksums and Phase 1 financial source binding.

Business rows have composite sandbox ownership relationships and forced RLS. Transaction-local sandbox context is reset by COMMIT/ROLLBACK and is not an authentication substitute. The API separately verifies the capability, scope, generation and current session. An application credential remains trusted infrastructure; RLS does not protect against its total compromise.

| Role             | Privileges                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `tf_owner`       | NOLOGIN owner; no superuser, CREATEDB, CREATEROLE or BYPASSRLS                                                    |
| `tf_migrator`    | NOINHERIT login; controlled SET ROLE owner during explicit migration                                              |
| `tf_app`         | Non-owner login; scoped reads and execution of only create/read/rotate entry points; **no business table writes** |
| `tf_reconciler`  | Read-only business/reference tables with explicit cross-sandbox reconciliation policy; no access to capabilities  |
| `tf_maintenance` | Execute retention purge only; no application write or migration authority                                         |

Private security-definer helpers use qualified names, a fixed search path and revoked PUBLIC execution. Runtime cannot invoke the internal receipt writer or maintenance purge, become owner, disable RLS, alter triggers, or update/delete/insert audit records directly. Immutable update triggers supply an additional boundary. A privileged owner can ultimately alter schema; this is not WORM/regulatory storage.

## Transactions, receipts and recovery

Each command uses one checked-out `pg` client. Capacity admission/purge lock the singleton capacity row before sandbox rows. Rotation locks only its sandbox. Mutations within one sandbox serialize; different sandbox rotations can progress independently. Creation atomically writes sandbox, capability hashes, capacity, receipt and audit. Rotation atomically changes digests/generation and records its response/event.

Idempotency keys are 8–128 ASCII letters/digits/underscore/hyphen, scoped to sandbox across operations. SHA-256 fingerprints bind version, POST operation, sandbox and normalized input; capability digests replace secrets. Actor/session identities are excluded so a new authorized session can recover and replay. Receipt lookup follows current authorization but precedes expected-generation/expiry rejection. Same key/request replays original status/body/Location, marked `Idempotency-Replayed: true`. A conflicting operation/fingerprint returns 409 and never replaces the original. Ownership failures precede lookup and do not reveal an existing key.

Successful state transitions and authorized generation/reuse rejections receive one immutable receipt/event. Syntax/authentication/ownership/admission failures, exhausted quotas and attempts after the write lifetime do not grow the ledger. Transactional counts and deferred ledger/capacity checks reject incomplete commits. There are no committed pending receipts.

The application rechecks session/binding after body receipt, acquisition and work, then immediately before COMMIT dispatch. Dispatch defines admission ordering against logout: work already dispatched may commit; it remains recoverable. A connection failure around COMMIT is `503 OUTCOME_UNKNOWN`; retain the original key/journal. Only explicit deadlock/serialization failures before COMMIT are retried, at most twice. An absent receipt is not proof that an original concurrent operation has finished.

Pool maximum is four clients with at most twelve admitted operations; acquisition timeout is 500 ms, client query timeout 2 seconds, server statement timeout 1.5 seconds, lock timeout 750 ms and idle-transaction timeout 2 seconds. A five-second precommit deadline prevents late admission; existing HTTP transport bounds remain. Errors omit driver details and SQL parameters.

## API

All routes require the existing bearer session and retain the error envelope `{error:{code,message}}`. Financial/reference analytics endpoints are unchanged. The independently authored `contracts/openapi.yaml` defines strict fields, response shapes and statuses.

| Route beneath `/api/fixed-income/v1`         | Contract                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /workflow/status`                       | `{enabled:false,state:disabled}` without DB; otherwise ready/unavailable                                                  |
| `POST /sandboxes`                            | Trader; `{sandbox_id,read_capability,trade_capability}` plus Idempotency-Key; 201 and Location                            |
| `POST /sandboxes/recover`                    | `{sandbox_id,capability,scope}`; 200 and ephemeral binding; viewer read only                                              |
| `GET /sandboxes/{sid}`                       | Current binding and generation; 200 metadata/scope                                                                        |
| `POST /sandboxes/{sid}/recovery-keys/rotate` | Trade binding plus trader; `{expected_generation,read_capability,trade_capability}` plus key; 200; recover anew afterward |
| `GET /sandboxes/{sid}/commands/{key}`        | Original completed receipt for outcome resolution                                                                         |
| `GET /sandboxes/{sid}/audit-events`          | Read-only event pages, limit 1–100 (default 50), signed cursor                                                            |

Metadata timestamps are UTC strings; generation and commit sequence are decimal strings. No raw capabilities or stored digests are returned. Unknown/repeated query fields and unknown body fields are rejected. Audit cursors pin an upper committed sequence, bind sandbox/limit and expire after five minutes; process restart invalidates signatures. No mutable-list pagination is implemented in this milestone.

Errors distinguish validation (400/413/415), existing session (401), role/binding (403), foreign/unknown/revoked/purged ownership (404), key/generation/expiry/cursor conflicts (409), admission/quota (429), and persistence/schema/capacity/uncertain commit (503). Existing `/health`, equity and stateless analytics continue when PostgreSQL is unavailable. No in-memory persistence fallback, fabricated empty response or automatic database migration is used.

## Retention, capacity and cleanup

Writes are permitted for seven days from creation; read recovery/history persists until day thirty. Requests do not extend either deadline. Receipts remain throughout retention. Limits are 50 retained sandboxes, 512 commands and 1,024 events per sandbox. Phase 2A emits one event per command, so the command bound is reached first. A maintenance-only function purges expired sandbox/access/receipt/audit rows atomically and decrements retained capacity. Active records cannot be purged through it. No HTTP reset/delete endpoint exists.

Tombstones retain only synthetic UUID and purge timestamp for the lifetime of that local database, outside the retained-sandbox capacity. They contain no identity, financial data, capabilities or digests. This small metadata exception deliberately prevents accidental ID reuse after all business records and credentials are removed. Reinitializing an intentionally destroyed local database starts a new database identity.

## Reproducible local/CI operation

The default owned-instance backend uses digest-pinned `postgres:17.10-bookworm`. It generates private SCRAM credentials, binds only `127.0.0.1`, labels a uniquely named container/volume with ownership proof and never prunes shared Docker resources. Migration requires a private descriptor, an owned loopback name and a database marker matching its nonce. Runtime uses only the dedicated app URL. Passwords are retained before role bootstrap commits.

```sh
npm ci
npm run db:local -- create
# Use the private descriptor PATH printed by create; it contains credentials: do not display or publish it.
npm run db:local -- serve PATH
npm run db:local -- stop PATH
npm run db:local -- resume PATH
npm run db:local -- purge PATH
# Explicitly destroys only the descriptor-owned local container, volume and private directory:
npm run db:local -- destroy PATH
```

Stop preserves data/descriptor; resume and a fresh login plus recovery restore access. Serve builds existing browser assets and injects the app URL in child-process memory, without printing it. Local app hosting remains loopback-only. No hosted database or paid service is used.

```sh
npm run validate
npm run test:postgres
npm run test:postgres
npm test -- --repeat-each=2
# Combined legacy + twice-isolated PostgreSQL gate, where Docker is available:
npm run validate:all
```

`test:postgres` creates a fresh owned PostgreSQL instance, bootstraps roles/migrations, runs all PostgreSQL tests without retries, asserts retained capacity is zero, then destroys only its own resources. Missing Docker/required PostgreSQL fails instead of skipping. `TF_PG_BIN` may select installed PostgreSQL 17 native binaries for the same ephemeral POSIX supervisor; binaries are not bundled or installed by the application. CI uses the digest-pinned Docker backend twice, not a paid or external database. Global capacity tests run serially in their owned database; explicit concurrency cases use independent connections and processes.

The supervisor handles SIGINT/SIGTERM during startup and execution, stops further admission, terminates and awaits its owned verification process group, and awaits idempotent resource cleanup before exiting nonzero. SIGKILL cannot be handled. After an interrupted supervisor, use `npm run db:local -- destroy PATH` with that instance's private descriptor; ownership checks apply to both Docker resources and native test descriptors. Never use global Docker prune/reset as recovery.

`verification/sql/foundation.sql` independently reconstructs command/audit counts and generations. It runs with the read-only reconciler in a consistent snapshot; a deliberate projection corruption must be detected. This is foundation integrity verification, not the execution/position/cash reconciliation reserved for later milestones.

## Verification and operational limits

Required evidence includes actual role/RLS checks, pooled context reset on commit/rollback, revoked scopes/generations, concurrent same-key creation, key conflicts, capacity races, command exhaustion, expiry/purge, safe migration repetition/checksum rejection, actual HTTP lost responses after creation/rotation, SIGKILL before/after COMMIT, real PostgreSQL stop/restart and preserved legacy routes during outage. Existing Python financial verification remains independent and unchanged.

No browser ownership UI, public durable login, external integration, throughput capacity, production backup/restore, regulatory audit retention or high-availability claim is made. There is no production release in Phase 2A. Rollback means disable the workflow and use a reviewed compatible artifact while retaining the database; do not delete data or edit migrations that have been released. Any future schema/model writer upgrade requires explicit compatibility review.

Phase 2B requires separate approval for RFQs, synthetic dealer responses and atomic quote acceptance. This foundation supplies ownership and transactions but does not authorize that work.
