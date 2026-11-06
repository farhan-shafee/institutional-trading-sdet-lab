# Public institutional workflow — proposed release contract

## Intent and acceptance

Deliver the existing synthetic equities, bond analytics, RFQ, execution ledger and reconciliation experience at the existing public TradeFlow URL without the owner's computer. The local interview launcher remains a backup. FIX remains bounded application validation and offline session evidence, with no transport or dealer connectivity. Completion requires exact-source local and hosted verification, owner acceptance, and a separately approved production release with public readback.

This document authorizes no production mutation. New runtime behavior and short demo retention are proposals for review; existing local contracts remain unchanged.

## Approaches

1. Upgrade the existing hosted equities/analytics slice alone. This is smaller but does not meet the owner's full workflow goal.
2. Introduce a dedicated hosted synthetic workflow profile and PostgreSQL database. Recommended engineering approach: reuse financial services, RLS, immutable ledgers and reconciliation; add public ownership bootstrap and bounded demo retention separately.
3. Forward public requests into the existing local supervisor. Rejected: depends on local infrastructure or exposes private provisioning authority and creates unnecessary proxy/session failure modes.

The owner has requested the complete public experience. The detailed implementation choices below are engineering proposals, not claims of prior owner approval.

## Boundaries

- Preserve legacy `local` and `hosted-demo` behavior and tests. `TRADEFLOW_FIXED_INCOME_WORKFLOW=postgres` continues to reject hosted mode and external targets. The new activation is distinct and default off.
- Preserve all existing base migrations/checksums, financial conventions, precision, order transitions, reconciliation semantics and FIX contracts. A separate optional database profile supplies only public demo ownership/lifetime metadata and creation.
- Public mode requires a dedicated branded database, least-privilege `tf_app`, separate read-only `tf_reconciler` and maintenance authority. App credentials cannot migrate, change roles, alter ledgers, or invoke maintenance.
- Verify database certificate chain and hostname. Reject URL TLS/query overrides, shared/unbranded databases and partial configuration. Never use `rejectUnauthorized:false` or ambient insecure TLS overrides.
- Keep the current Cloudflare tunnel topology and existing public deployment unchanged throughout candidate work. No production database, volume, credential, configuration or deployment changes until separately reviewed and approved.

## Public ownership and lifetime

An authenticated synthetic trader or viewer explicitly starts one private workspace. The server creates random ownership material before database dispatch, retains it privately for the lifetime of the synthetic session, binds the result to that same session, and returns only validated sandbox metadata and scope. Ownership secrets never enter browser state, responses, logs or URLs. Viewer workspaces bind read-only. Caller-supplied ownership/bootstrap/recovery/rotation routes remain unavailable in public mode.

Concurrent and repeated start requests for one session resolve the same retained intent. Uncertain commits retain that exact intent/key; retries cannot generate another workspace. Logout/expiry invalidates bindings even during body receipt or database acquisition/commit admission. Restart discards synthetic sessions; cross-restart visitor recovery is not offered. Orphaned committed workspaces remain bounded by database retention.

**Proposed public-only policy:** writes end after 30 minutes; synthetic records are retained for 60 minutes and then become eligible for maintenance purge. The 60-minute period is server-side record retention only, not a promise of visitor read/recovery access. Access ends at logout, process restart or the original synthetic session expiry (at most 30 minutes from login), whichever occurs first; starting a workspace later does not extend the session. Absolute lifetime is not extended by requests. The existing local seven-day write / thirty-day retention contract is untouched. Show the public policy accurately in UI and wire metadata. Preserve the existing maximum 50 retained sandboxes, command/event quotas and workflow admission limits. Exhaustion fails closed with visible retry guidance.

Public-only records are created through a distinct database function with literal short lifetimes and an explicit profile marker. Existing immutable records and purge eligibility rules remain authoritative. The existing maintenance purge removes only expired records, never active records, with no public reset/delete route. A bounded maintenance worker uses the separate maintenance credential, checks the dedicated profile, reports failure safely and never claims cleanup that did not occur.

Public UUID retirement metadata is also bounded: the public-only wrapper removes only tombstones newly produced for its own expired public graphs in that purge transaction. Legacy tombstones are preserved. This exception is possible because public sessions expire before retention, restart recovery is unavailable, callers cannot supply UUIDs/capabilities, and no public intent can retry after its graph is eligible for purge. It is not a change to the local durable ownership/replay contract.

## User experience

- Existing synthetic login, equities and fixed-income analytics remain functional when persistence is unavailable.
- Public workflow shows a Start private workspace action instead of native capability recovery instructions. Native local UI remains unchanged.
- Existing RFQ/dealer quotation, lifecycle, execution and reconciliation views operate against the private binding. Mutation-disabled viewer behavior remains server-enforced.
- Display synthetic/session/retention limitations and unavailable/capacity states. Do not silently replace database errors with empty or fabricated financial results.
- Add an evidence area with immutable source/test/CI references and verified FIX examples; accurately distinguish test evidence from a running FIX engine.

## Release verification

Require independent HTTP/OpenAPI bodies, exact financial values, real PostgreSQL role/RLS/immutability, two-visitor isolation, viewer denials, same-key replay/conflict/uncertain outcomes, logout/expiry races, database outage, bounded capacity, cleanup failures and safe restart. Add normal browser coverage on actual public profile without test-only authorization exemptions. Retain all existing mandatory gates and counts as separately dated runs; do not relabel historical tests.

Rehearse deployment with a dedicated environment/database, strict TLS and pinned source. Production cutover requires explicit owner approval after review, successful local/hosted gates and a concrete rollback plan. Do not deploy the app alone while claiming the workflow is enabled. Public acceptance includes two independent visitor sessions, analytics/RFQ/execution/reconciliation, permission boundaries, health, disclosure and exact deployed source.

## Open release dependencies

The provider database image/version, CA/hostname evidence, migration authority, operating cost and final public-only retention policy need concrete review before hosted provisioning or production acceptance. Defaults above guide a candidate; they are not a production approval. A deployable artifact is not a deployed or fully accepted public product.
