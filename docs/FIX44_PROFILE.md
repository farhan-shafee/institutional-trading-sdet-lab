# TradeFlow FIX 4.4 bilateral profile v1

This module is a **bounded application-message byte codec**. It encodes and validates standalone synthetic FIX messages. It does not send messages, authorize financial commands, create orders/executions, maintain sessions or implement a FIX gateway. No application HTTP route imports it. The existing optional workflow remains OFF by default.

The independently authored executable contract is [fix44-profile-v1.yaml](../contracts/fix44-profile-v1.yaml). Its field matrix distinguishes base FIX requirements from TradeFlow's additional bilateral requirements. Unsupported FIX messages may be valid in the standard and still be rejected by this profile.

## Standard references and external dictionary

References consulted: [FIX Trading Community's FIX4.4 repository view](https://orchimate.org/fixtrading/fix-4.4), particularly NewOrderSingle, ExecutionReport, OrderCancelRequest, OrderCancelReject, StandardHeader and StandardTrailer. That repository view may include later extension packs; **only the pinned base FIX4.4 dictionary** supplies this phase's enum/membership checks. FIX4.4 Trade is ExecType=F; old FIX4.2 Partial Fill/Fill event values 1/2 are not supported ExecType values. OrdStatus carries partial/full state separately.

The unmodified [QuickFIX FIX44.xml](https://github.com/quickfix/quickfix/blob/aa1985560bfdaef2edc4d2aa51e119c2ff80b164/spec/FIX44.xml) is vendored at `verification/vendor/quickfix/FIX44.xml` with its original license and [provenance](../verification/vendor/quickfix/provenance.json).

- Source revision: `aa1985560bfdaef2edc4d2aa51e119c2ff80b164`.
- Dictionary: `FIX.4.4`, servicepack `0`; no FIX5 or extension-pack dictionary.
- XML SHA256: `a82655b54363aa9c6d1b2f21f294f1198c0d7125d7b44c26d93d3179f3358425`.
- License SHA256: `04719eefe7adf383d7970d7654caec6f7e542e6427f25d068e7177495fc9b379`.
- QuickFIX Software License, Version1.0: retain notices, conditions and disclaimer; reproduce notice in binary documentation, provide acknowledgment, no endorsement/name misuse. Original license is retained unmodified.

**This product includes software developed by quickfixengine.org (http://www.quickfixengine.org/).**

The independent Python dictionary-driven checker reads this XML, expands components, checks flat message membership, required fields, primitive formats and enum values. It does **not** run the QuickFIX C++ engine, validate all prose-only FIX conditions or demonstrate session interoperability. Its negative controls prove it rejects a missing AvgPx, old execution-type values, invalid enum/type/date and fields belonging to the wrong message. The separate bilateral checker handles selected quantity/price/event relationships. A dictionary-only success is insufficient: LIMIT Price and profile-specific rules need additional checks.

## Encoding, decoding and resources

Public entry points in `app/protocol/fix44/index.ts`:

- `encodeFix44(fields)`: framing tags8/9/10 excluded from input; emits a Buffer in deterministic profile order. Other fields are exact strings. No timestamp or sequence is generated implicitly.
- `decodeFix44(bytes)`: requires exactly one complete frame; returns immutable type, direction and fields including8/9/10 only after full validation.
- `renderFix44(decoded)`: pipe rendering derived from a provenance-checked decoded message. It is display text, not accepted wire framing or a logging recommendation.
- `Fix44Stream.push(bytes)`: copies bounded owned bytes, emits at most16 messages; `maxBatch` may reduce that to1..16. Returns ready/incomplete/backpressure plus buffered byte count.
- On backpressure, retain the caller's next chunk and drain with `push(Buffer.alloc(0))` before supplying more input. Rejected BACKPRESSURE input is not consumed. A full buffer is not silently truncated or flushed.
- `finish()`: asserts end-of-input with no retained prefix. Drain backpressure before finish. A remaining prefix throws TRUNCATED. This is an end-of-input check, not session/logout behavior.

Actual SOH is byte`0x01`. BeginString is first, BodyLength second, MsgType third. BodyLength counts bytes from the first byte of35 through the SOH preceding10. CheckSum is the sum of all preceding bytes modulo256, exactly three digits, followed by the final SOH. Header fields form the ordered contiguous block listed in YAML; body fields may arrive in a different flat order. Encoder always canonicalizes field order, never numeric text.

Limits:8KiB frame,64 fields,16KiB retained bytes,16 emitted messages per push,256 bytes per value; identifiers and values have narrower profile limits. Admission checks run before copying oversized input. Oversized chunks must be split by the caller; rejected overflow poisons the parser rather than discarding bytes and attempting recovery. Incremental input is never classified as a valid business message until complete. A malformed frame poisons the stream, releases retained bytes and rejects subsequent input. If a coalesced batch includes a malformed frame, the call throws and emits none of that call's accumulated messages. There is no scan-to-next-header resynchronization.

`Fix44Error` contains fixed safe diagnostic codes, no field values or raw bytes. TRUNCATED indicates incomplete end-of-input; stream incomplete is a normal result. UNSUPPORTED_MESSAGE/FIELD/VALUE denote out-of-profile content; malformed byte/field/conditional failures and resource/backpressure errors remain distinct. Byte integrity and the common header are checked before unsupported-message classification. The codec deliberately does not authenticate CompIDs or infer trust from syntactically valid identities.

## Financial and identity semantics

USD face quantities preserve exactly two places. Original total OrderQty is at least1.00, at most1000000000.00; LastQty is at least0.01 and cannot exceed CumQty. CumQty/LeavesQty are nonnegative and bounded. Comparisons use scaled BigInt; prices are never parsed as JavaScript numbers. Positive clean Price/LastPx preserve exactly twelve places, maximum99999.999999999999. AvgPx is twelve-place zero before fills or the common contractual price thereafter; it is not a cost-basis calculation. This profile only supports a single frozen clean price for all fills.

The two instruments retain Phase1 source `6016fb700840d081fe1fba651c918f0a7e709383`, revisions `phase1-ust-1`/`phase1-corp-1`, model `phase1-regular-coupon-v1`, regular semiannual4% coupon, dated2025-01-15 and maturity2031-01-15. Treasury uses Actual/Actual ICMA, corporate US30/360. FIX wire fields do not transmit every frozen contractual term; **future** correlation must bind immutable original snapshots. Codec validation alone cannot prove a wire price equals an accepted RFQ, verify BUY took ask/SELL took bid, or validate prior state/history. No financial calculation, accrual, execution cash or rounding algorithm is introduced.

PriceType423=1 means percentage/per100par, not dollars per bond. QtyType854=0 means units, defined bilaterally as USD face amount. Side54=1/2 is the original client's BUY/SELL throughout, not inverted for dealer reports. Currency is USD; SettlDate64 preserves the frozen contract date. SettlType63 is omitted; no settlement, holiday adjustment, cash movement or PnL is inferred. Valid settlement dates are2025-01-15 inclusive through2031-01-15 exclusive. TransactTime60 is original event time; TradeDate75, if present, is its UTC date, not settlement. UTC timestamps support seconds or three-digit milliseconds, years1900..2199, without leap seconds or timezone offsets. No current-clock freshness rule is invented.

D carries original lower-case UUID ClOrdID, never a fabricated dealer OrderID. F carries a different cancellation UUID in11, original order UUID in41, known dealer37 and **original total**38. Reports for New/Reject/Trade retain original11; PendingCancel/Canceled use cancellation11 and original41. ExecID is a report identifier, present only on8, not proof of a fill. OrderCancelReject9 has no ExecID. Dealer IDs are prefixed ATLAS-/BIRCH-/CEDAR- and must agree with the directional CompID. This is fictional identity validation, not authorization or durable uniqueness.

## Event and status matrix

| Message/event                    | 150    | 39    | Quantity rules / identifiers                                                 |
| -------------------------------- | ------ | ----- | ---------------------------------------------------------------------------- |
| New acknowledgment               | 0      | 0     | Cum=0, Leaves=Q; original11                                                  |
| Original rejection               | 8      | 8     | Cum=0, Leaves=0;103=6 or99; original11                                       |
| Trade partial                    | F      | 1     | 0<Cum<Q, Leaves=Q-Cum; positive32,31=44                                      |
| Trade full                       | F      | 2     | Cum=Q, Leaves=0; positive32,31=44                                            |
| Dealer pending-cancel            | 6      | 6     | Cum+Leaves=Q; cancellation11/original41                                      |
| Trade while pending-cancel       | F      | 6     | 0<Cum<=Q, Leaves=Q-Cum; original11; includes full-fill-before-cancel outcome |
| Canceled                         | 4      | 4     | Cum<Q, Leaves=0; cancellation11/original41                                   |
| Cancel rejected, synthetic other | absent | 0 or1 | 434=1,102=99; cancellation11/original41                                      |
| Cancel rejected, too late        | absent | 2     | 434=1,102=0; cancellation11/original41                                       |

No last-execution fields on nontrade reports. Rejected/canceled terminal Leaves=0 is an explicit exception to Q=Cum+Leaves. Requesting cancel is not cancel acknowledgment. Pending-cancel status has precedence over partial/full state when the dealer has acknowledged it; a later full trade may still carry39=6, followed by CancelReject with39=2. This codec checks allowed combinations only; a future adapter must enforce actual preceding pending request, correct commit ordering, duplicate IDs, aggregate versions and terminal-state protection. Duplicate-order reason103=6 is not proof that the original economic order was rejected. Unknown-order37=NONE, replace, trade corrections/busts, status-based inferred executions, arbitrary reports/reasons and session messages are outside v1.

PossDup43=Y requires valid OrigSendingTime122 no later than52. Otherwise122 is forbidden. The codec checks fields, not sequence continuity, replay eligibility or economic idempotency. It never creates or retransmits a financial command.

## Verification and boundaries

`npm run test:unit` includes codec and YAML contract tests. `npm run test:fix44` runs independent Python tests and independently validates all TypeScript-encoded frames against frozen raw goldens and the pinned dictionary. `npm run validate` and the quality workflow include this mandatory gate. Existing financial, PostgreSQL, API/contract and all three-browser gates remain required and unchanged.

Golden `.fix` files contain actual SOH, no newline and no secrets. Their independently constructed field manifests, byte counts, checksums and SHA256s are in [manifest.json](../test-data/fix44/manifest.json). These are fictional standalone messages, not evidence of persisted orders or trading integration. Repeated serialization is deterministic, and independent verification never imports TypeScript to obtain expected byte counts/checksums.

There is no delivery, socket, Logon, Heartbeat, TestRequest, ResendRequest, SequenceReset, persistence, FIX inbox/outbox, financial-command adapter or actual local counterparty interoperability. Those require separate approvals. Phase3B1 should establish correlation/ownership, protected capacity, a fenced per-order command lane and a guarded existing-kernel transaction boundary before enabling any protocol-driven financial event.
