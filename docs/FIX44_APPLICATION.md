# Controlled FIX application (Phase3B2)

This candidate branch applies explicitly authenticated, synthetic local/CI FIX transcripts through the existing financial kernel. It is not a FIX gateway, session engine, network endpoint or regulated trading venue. Delivery and external completeness are always unverified. The feature defaults OFF; no HTTP route, automatic process or environment flag activates it. Existing public hosting, equity sessions and financial conventions are unchanged.

## Boundaries and transaction

`FixFoundationService` retains its versioned metadata contract. `FixApplicationService(database,true)` is the separate internal opt-in entry point. Its `apply(binding,actor,input,key,verify)` accepts only order_id, work_id, current owner_id and fence. `ingest(...)` accepts only order_id, retained attempt_id and exact raw_hex. Callers retain their non-secret original request and key before submission and supply the trusted current-session verifier; this SDK is server-side, never browser capability storage.

`fi_control.apply_fix` locks sandbox→lane→order state, verifies current trade proof/generation/fence/lease, exact frozen correlation and unresolved lane head, and invokes the byte-identical private `order_command_kernel` on that connection/transaction. It never calls `OrderService.command()`. A successful application atomically commits the existing financial effect/receipt/audits, original prepared-key promotion, capacity consumption, immutable applied outcome, protocol receipt and event. An exception or failed COMMIT rolls every effect back. Session verification runs again immediately before COMMIT; deferred checks reject an expired lane fence at commit for both financial applications and protocol-only observations. Stale owners cannot mutate. Already committed original-key recovery is an authorized read of the original result.

The original public financial signature and function OID remain unchanged. Unbound/manual behavior and original financial-key replay are preserved; new manual mutations of FIX-bound orders remain denied by the existing guard. `tf_app` receives only narrowly scoped application/ingest EXECUTE and forced-RLS SELECT; no business-table writes, private-kernel or private-context access. No additional login role is created.

## Additive schema7

Migrations001–006 are unchanged.007 adds:

| Relation                     | Responsibility                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| fi.fix_applications          | Immutable applied work/message→financial receipt/key/hash/command sequence, protocol receipt, fence and generation                   |
| fi.fix_consumptions          | Immutable one-command/actual-event consumption, deferred FK and effect proof                                                         |
| fi.fix_protocol_observations | Validated dealer pending-cancel evidence at a specific financial history version and committed fence/generation; no financial effect |
| fi.fix_unresolved_ingest     | At most8 rejected ingress records/order, hash and fixed reason only; no untrusted raw payload, trusted message or economic identity  |
| fi_control.fix_apply_context | Owner-only transaction-specific exact-key promotion authority; removed before success                                                |

All new business records have composite sandbox references, forced RLS and immutable evidence.007 extends the existing command-registry trigger and universal capacity guard, adds new completion sources to the lane-head query and extends the existing authorized full-graph purge. The immutable original order, quotation and execution contracts remain authoritative. Old METADATA_ONLY outcomes are never rewritten to become applied outcomes. A legacy unvalidated metadata completion cannot unblock new application ordering; only a validated observation or financial application does so. Older staged/prepared006 records can upgrade and apply without replacing their original keys or payloads.

## Keys, identities and uncertainty

The prepared hash remains SHA256 of canonical PostgreSQL JSONB payload text. The financial request hash is separately calculated over the exact compact ordered version1 POST envelope used by OrderService: version, method, operation, sandbox_id, payload. Payload property order is order_id, expected_version, then execution_id/source_event_id/par_amount or cancel_id. Tests independently compare actual stored receipts with Node's request-envelope hash; SQL reconstructs it without calling application helpers.

The financial insertion trigger promotes the existing registry row from FIX_PREPARED to FINANCIAL by UPDATE only when the private transaction context matches the immutable prepared work, operation, key and fingerprint. There is no deletion/recreation window. Failed application leaves FIX_PREPARED intact. Successful original-key replay returns the original receipt without another effect or consumption. Duplicate physical attempts and logical ExecIDs preserve the same message/candidate execution/source UUIDs. Changed economics under one identity conflict.

Protocol control keys and financial keys are distinct. Reclaim uses new current ownership/fence metadata while retaining the original financial key, payload and event identities. First query/replay the retained original control request; a missing receipt is unresolved, not proof of failure. Application recovery rechecks the durable applied-work reference while holding the sandbox/lane lock. If already committed it returns that original outcome; otherwise only the current fenced owner may apply the same prepared financial identity. It never invents a replacement financial key. No in-memory fallback exists during outage.

## Message-to-kernel contract

The unchanged TradeFlow-FIX44-v1 codec/profile remains deliberately restricted. Actual SOH bytes, exact12-place clean price, two-place USD face, original instrument/revision/model/settlement and client side are preserved.

| Message | Authorized behavior                                                                                                   |
| ------- | --------------------------------------------------------------------------------------------------------------------- |
| D       | Stage/export the already-existing RFQ-accepted order; no order creation; never SENT/DELIVERED                         |
| 8/150=0 | ACK_ORDER only PENDING_ACK, explicit zero CumQty and original leaves                                                  |
| 8/150=8 | REJECT_ORDER only PENDING_ACK with103=99 and controlled SYNTHETIC_REJECTION; duplicate103=6 stays unresolved          |
| 8/150=F | EXECUTE_ORDER using retained candidate UUIDs, explicit LastQty/LastPx and exact post-event CumQty/LeavesQty/AvgPx     |
| F       | Stage original cancellation and apply REQUEST_CANCEL through this transaction boundary; staging alone has no effect   |
| 8/150=6 | Validated dealer pending-cancel observation only; no local financial state transition or consumption                  |
| 8/150=4 | ACK_CANCEL only matching current pending request, unfilled remainder, exact executed cumulative quantity              |
| 9       | REJECT_CANCEL for matching pending request:99 ordinary with matching0/1 status, or0 too late with already FILLED/39=2 |

Only the financial kernel calculates accrued interest, execution consideration, positions and signed cash. No cumulative/status report creates inferred executions. Report totals must equal the actual transition; contradictions leave their prepared head unresolved and block later application. No replacement, bust, correction, settlement or cost-basis behavior exists.

Local pending cancellation, dealer pending-cancel observation and financial order status are separate. Before a validated dealer6, a trade reports1/2; after6 for the current cancel it reports6, including the final fill. Partial fills remain committed when cancellation acknowledges the remainder. A verified9 too-late response clears the pending cancellation after full fill and preserves FILLED. A contradictory4 after full fill is unresolved, not an automatic reversal or fabricated rejection.

The new ingest interface retains rejected profile/correlation input as bounded hash-only unresolved evidence, while the legacy strict codec/RECORD API continues to reject it. This includes unsupported unknown-order cancellation rejection; it cannot erase fills or produce local rejection. Hash-only evidence does not claim that the invalid payload was decoded or that an external counterparty was authenticated. CompIDs are correlation labels, never external authentication.

## Protected capacity and bounds

Each binding still reserves25 financial commands and43 audit slots. Maximum effects:1 acknowledgment/rejection +8 fills +8 cancellation requests +8 outcomes =25 commands;1+8×3+16=41 actual audit events. Two reserved event slots cover the existing conservative +3 admission. Consumption is exactly1 command and actual1/3 events, backed by the applied kernel receipt, history and audits at COMMIT. Pending-cancel observations, retransmission, duplicate replay, failed transactions and unresolved work consume none.

The universal guard counts actual counters plus remaining protected budget for every financial writer, under the common sandbox lock. Reservations never shrink without a committed effect and are never released while evidenced/uncertain work can apply. Terminal unused budget remains retained until authorized retention cleanup; this conservative behavior is bounded, not an unlimited resource promise.

An additive correction addresses a reproduced inherited edge: a rotation previously spent one shared security slot, then the next ordinary/FIX writer was charged a fresh two-slot headroom again. At quota that stranded a valid reserved lifecycle.007 reconstructs unused headroom as max(2−actual rotation receipts since the first active binding,0), rather than replenishing it. Rotation still cannot spend protected lifecycle budget; all512/1024 limits remain. A failing429-versus200 regression became green after the correction. Both full25/41 lifecycle and rotation-before-application quota tests execute against real PostgreSQL.

Other limits remain4 bindings,8 fills/cancel requests,40 messages/work per order,4 attempts/message,960 ordinary/1024 recovery protocol receipts,15-second lane leases,7-day writes and30-day retention. Rejected-ingress hashes add at most8/order. The application pool/deadlines/retries are unchanged. Cleanup holds sandbox ownership, respects live leases, removes the entire expired application/protocol/financial graph and restores retained capacity to zero.

## Independent verification profiles

Financial reconciliation-v1/schema5 and v2/schema6 metadata remain accepted byte-for-byte; current financial manifests are v3/schema7 with seven exact hashes and the unchanged four independent financial SQL queries. The historical fix-foundation-v1 verifier and its NOT_IMPLEMENTED/NOT_EVALUATED claims remain unchanged; it is not an application verifier on new applied data.

`verifyFixApplication` authorizes the snapshot with the reconciler role, then runs those four financial queries and the hash-bound independent `fix_application.sql` in one repeatable-read/read-only transaction. It checks raw bytes/checksum/semantic identity, frozen correlation, original prepared hash and financial fingerprint, key promotion, actual receipts/history/execution/source identities, per-report quantities, cancellation references, lane order, consumed capacity and audits. Controlled isolated corruption must create findings. It uses authoritative executions to reconstruct positions/cash via the existing independent financial queries, never a whole-order estimate.

Reports carry separate financial, protocol control, ingest, preparation and financial-application watermarks. OBSERVED_APPLICATION_CONSISTENT requires complete observed-message application and zero independent financial/protocol findings. It verifies only the supplied retained transcript and snapshot; delivery_verified and external_completeness_verified are always false. No clean result proves an unobserved message did not exist. Foundation historical results are never relabeled.

The independent Python transcript oracle parses actual stored bytes, runs the pinned base FIX4.4 dictionary checker, ties report IDs and explicit fills to ledger UUIDs, and calculates rational per-fill cash/positions independently of TypeScript and SQL financial functions. Tests cover both conventions, BUY/SELL, coupon dates, leap day and separate HALF_EVEN rounding. It is not a QuickFIX session-engine interoperability test.

## Evidence, rollback and next decision

See docs/plans/PHASE3B2.md for executed test counts, retained failures, review findings and final CI links. Proposed tests and unsupported capabilities are not passing-test claims. The source review and final human acceptance are distinct.

Rollback is disable the optional SDK with schema-compatible code; retain immutable evidence, prepared keys and uncertain outcomes. Do not drop007 data or deploy an old persistence binary that rejects schema7. Existing feature-OFF equity/analytics/public deployment remains independent of PostgreSQL. Older phase dependency locks may now fail the newly published minimatch advisory on re-execution; they were deliberately not edited. Any earlier security-only remediation/retargeting requires separate approval. Later integration must review the whole unmerged stack bottom-up with populated migration and final-source test gates. Integration/merge review is recommended before adding Phase3C complexity; neither merge nor session implementation is authorized here.
