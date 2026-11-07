# Selected live financial ingress — Phase3C2 work in progress

This implementation is in progress on a branch based on the qualified Phase3C1
runtime. It is not a completed financial adapter, accepted release, merge or
deployment. See the [design](superpowers/specs/2026-11-07-fix-live-ingress-design.md)
and [implementation plan](superpowers/plans/2026-11-07-fix-live-ingress.md).

The first boundary is a separate `live-fix-ingress-v1` decoder. It preserves the
observed bytes and SHA256 in a private provenance registry. Fresh ordered headers
are8,9,35,34,49,52,56; retransmissions add43=Yafter34 and122after56. Header timestamps
require real UTC calendar dates and exactly three fractional digits. Only ATLAS
is selected: D/Fgo TRADEFLOW→ATLAS;8/9return ATLAS→TRADEFLOW. NewOrderSingle requires
transport field21=1. Existing business value/required-field rules remain intact.

A parsed-field projection validates business terms; it is never encoded into
replacement wire or admitted to the legacy decoder trust registry. Calling
`decodeFix44` on these actual header layouts still rejects FIELD_ORDER. A live
parsed result proves neither ownership nor financial eligibility. SQL observation,
validated engine callback, fenced preparation/application and independent financial
verification follow separate boundaries; the financial kernel remains authoritative.

The additive database boundary now uses opt-in migration009 in
`db/live-migrations`, `LiveWorkflowDatabase` and `LiveFixApplicationService`.
Bootstrap the existing owned schema8 first, then explicitly call `migrateLive`.
Repeated live migration verifies the exact nine checksums; default schema8
clients reject schema9. No default loader, public route or legacy migration is
changed. The SDK is disabled unless explicitly constructed with `enabled=true`.

SQL retains original observations, accepts a separate matching callback witness,
checks owned order terms itself and stores engine sequence slots by store and
direction. Connection ordinals fence earlier process connections. Raw evidence
alone cannot prepare or apply. Existing public metadata, ingest and apply entry
points reject a live binding; private snapshots preserve their proven command
and financial application bodies. Live request fingerprints extend receipts
with the full profile/context without another quota charge. Rollback removes
financial effects and capacity consumption together. An unknown COMMIT is never
retried internally; recovery uses the original key and intent.

The database admission tests author callback witnesses solely to test SQL. They
are not evidence that a real engine emitted those callbacks. The real-engine
bridge and independent financial/crash qualification remain unfinished.

`npm run test:fix-live` verifies20 literal wire vectors through TypeScript and an
independent Python/dictionary oracle. Fourteen authored financial-valid frames
are distinguished from six unmodified captured3C1 transport probes. The latter
remain negative cases: some have synthetic non-UUID references and others lack
required business fields such as59/37/60. Nothing silently repairs those bytes.
