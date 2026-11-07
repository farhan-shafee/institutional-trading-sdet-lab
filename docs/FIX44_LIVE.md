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
verification are later plan tasks; the financial kernel remains authoritative.

`npm run test:fix-live` verifies20 literal wire vectors through TypeScript and an
independent Python/dictionary oracle. Fourteen authored financial-valid frames
are distinguished from six unmodified captured3C1 transport probes. The latter
remain negative cases: some have synthetic non-UUID references and others lack
required business fields such as59/37/60. Nothing silently repairs those bytes.
