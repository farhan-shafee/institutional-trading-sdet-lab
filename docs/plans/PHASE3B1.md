# Phase 3B1 implementation ledger

Approved exact base: 5afab8170791db252d2a0992c701084f44bbdf42 / tree 6d1bd9beb43ff3fef51810c92c8321f38179b9dc. Scope: protocol metadata foundation only. Financial application and delivery are disabled and have no callable entry point.

## Preflight (read-only, completed before branch creation)

PRs6–11 are open/unmerged at the approved heads, each base equals the preceding phase head. Local Git history proves continuous ancestry from main3fd9b0a through all six phases. Phase3A four final-source workflows41136093750/41136117556/41136093712/41136117522 all succeeded on first attempt. Migrations001–005 match their recorded SHA256s unchanged.

Inspected order_command, OrderService's independent transaction, execution/source-event uniqueness, pending/full-fill cancellation behavior, command registry, quota counters, forced RLS, metadata schemas, scanner manifest and authorized cleanup. No unresolved material preflight blocker. Compatibility requires a private renamed kernel plus same-signature guarded wrapper, a sandbox counter guard for every writer, explicit FIX/prepared-key domains, historical metadata union and schema6 provenance. Old binaries deliberately fail closed against a newer optional database. No earlier branch is changed.

Eventual integration: review and merge bottom-up PR6→7→8→9→10→11→this PR, preserving ancestry while stacked. Retarget/retest only on later explicit approval. Full-stack/populated-upgrade gates before each release; merge is not deployment permission. Rollback disables the feature with a schema-compatible build; no destructive downgrade of retained evidence.

## Implementation tasks

1. Failing real PostgreSQL foundation tests, then additive006 and ownership/correlation, receipt/evidence, reservation and lane functions.
2. Thin disabled-by-default internal service, independent SQL foundation verifier, historical/new metadata compatibility. No HTTP or delivery endpoints.
3. Migration/role/concurrency/fault/recovery/retention and full regression verification; fresh independent whole-branch review and material fixes.
4. Commit/push own branch, stacked unmerged PR, inspect all final-source CI logs and completion report.

Lock order: service-capacity for retention only → sandbox → binding/channel/lane → order state. All ordinary mutations start at sandbox. Private kernel never runs in Phase3B1 FIX operations.

Capacity proof: per binding25 financial commands (1 acknowledgment,8 fills,8 cancel requests+8 outcomes),41 actual audit events (1+24+16), plus2 admission headroom =43 protected events. At most4 bindings/sandbox. An additional2 command/event slots per active sandbox are protected for one capability rotation plus its conservative admission margin; ordinary non-FIX writers cannot consume them. Metadata has its own bounded receipts/events. Duplicate/rejected reports are metadata, never a reason to spend lifecycle reservations. Future reserved consumption must require a real atomic financial effect; no consumption/apply function is enabled here.

Ruling: protocol foundation reconciliation is a separate versioned read-only profile, never COMPLETED_CLEAN or a delivery/application assessment. Existing financial four-query reports and historical metadata remain intact; new financial manifests record physical schema6 honestly. This avoids relabeling old assessments and avoids adding protocol findings to financial ledger findings.

Implementation evidence checkpoint:20 targeted real-PG tests passed, then populated005→006 and preserved005-target tests passed. Full regression exposed pending-FK DDL during combined older-schema upgrades and an asynchronous checked-out pg-client error after COMMIT. Both reproduced in deterministic tests and corrected without timeout/retry changes. Targeted14 crash/combined-upgrade checks passed after fixes. Static/unit/protocol/financial checks executed; final full-stack and hosted source gates remain required.

Ruling: clone the original kernel body into a private function and replace the original public function at the same OID rather than rename it. This preserves prepared statement compatibility while enforcing the new guard; the real populated-upgrade test compares exact prosrc and OID plus original-key replay. The economic kernel body is unchanged.

Failure history: absent FIX function RED; PostgreSQL CASE parsing/variable qualification and bounded-regex limitations; missing trusted RLS context in a new test; a quota fixture's deliberately corrupt counters correctly tripped existing ledger consistency and was replaced with actual rejected commands; an independent upgrade-query fixture needed explicit sandbox filtering for unparameterized verifier sources; static type/lint corrections. No original assertions or existing timeout/retry policies were reduced.

Independent review: three Important findings, no Critical. Fresh reviewer independently reproduced UUID-spelling bypass of the manual-driver guard; false-consistent correlation/prepared snapshots; premature Trade preparation on PENDING_ACK. Corrected driver comparison to UUID values, added preparation prerequisites before any key/evidence insertion, and extended independent SQL to dealer/cancel/sequence/work/prepared/outcome/audit correspondence. Reviewer reproduction was read-only to source and used an independently owned PG instance, stopped afterward. Dedicated UUID/prerequisite regressions passed after RED; corruption checks now assert exact finding categories. Final full-source gates are running; no completion/hosted CI claim yet.

The pre-review full PostgreSQL run passed168 tests, including all138 inherited cases. This does not substitute for post-review verification. Final units115 and protocol/financial gates must be read from final run outputs. Earlier literal local tsx CLI restrictions remain; hosted literal gates remain mandatory.
