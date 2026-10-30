# Phase 3A verification record

This record belongs to the Phase3A codec candidate, based exactly on `9dee9cdcf10be5e8a751d3b8f4f1b9dd5a9113d4`. The final source commit/tree and hosted run URLs are reported in its stacked pull request. No results here demonstrate a FIX adapter or session interoperability.

## Local executed evidence

- Locked `npm ci` completed; no dependencies added or changed.
- Direct `node --import tsx --test tests/unit/*.test.ts tests/unit/fix44/*.test.ts`:113 passed,0 failed/skipped. This includes all84 existing assertions and29 new protocol/contract checks.
- `npm run test:fix44`:7 Python tests passed;14 fixed golden frames and14 TypeScript-encoded frames passed independent byte/dictionary/selected-semantic checks. Negative controls include missing AvgPx, invalid FIX4.4 event values, wrong message membership, malformed dates and financial text.
- Real local PostgreSQL regression:138 passed,0 failed/skipped; actual retained sandbox capacity returned to zero. Existing roles/RLS, migration checksums, transaction atomicity, crash/restart, reconciliation and SQL oracle checks executed. No new migration or business-table access was introduced.
- Independent financial HTTP verification executed, including existing54 deterministic financial cases; no financial code changed. Python discovery also executes the new protocol tests.
- Typecheck, lint, formatting, independent OpenAPI, workflow and migration-checksum validation, and production artifact build executed successfully before final publication. Hosted verification must repeat them against the final source revision.

Literal local `npm run validate` reached OpenAPI validation and then failed because the existing tsx CLI cannot create its Unix IPC socket (EPERM). The literal baseline unit and repeated Playwright commands were blocked by the same environment restriction. These are failed local invocations, not passes. Direct Node execution bypasses only that CLI mechanism, not assertions; it does not replace required hosted literal gates.

Local workflow-browser execution could start its owned database/server, but all42 browser cases failed during launch because browser executables are absent. No browser workflow success is claimed locally. An attempted direct production-smoke invocation failed its existing “invoke through npm” guard; no local smoke success is claimed. Neither guard nor launch/timeout policy was changed. The hosted workflows install all three browser engines and must execute both normal/repeated suites and the literal production smoke.

## Independent review and resolutions

A separate fresh-context source reviewer inspected the codec, profile, fixtures, independent checkers and gate changes. It executed the27 then-current protocol tests and6 Python tests/14 encoded-frame checks. It reported:

1. **Impossible partial frame prefixes classified incomplete.** Reproduced with BodyLength `X`, `0`, oversized digits without SOH and partial checksum `10=x`. Added failing prefix tests; validate available digits/bounds/trailer bytes before incomplete. Final valid fragmentation tests still pass at every byte boundary.
2. **Unsupported message masked malformed common retransmission header.** Reproduced with43=X or43=Y missing/invalid122. Added failing tests and moved common43/122 validation before unsupported message classification.
3. **Independent Python checker accepted shortened dates.** Python strptime accepts variable-width month/day strings. Treated as material verification defect even though runtime already rejected them. Added failing dictionary and profile negative controls; require eight ASCII digits plus calendar/range validation.

The three findings were reproduced RED and corrected GREEN in one fix pass. Final focused plus existing unit suite:113/113; independent FIX gate:7 Python tests and14 encoded frames passed. No unresolved material review finding or deferred minor remains. Full regression/hosted results are a separate release gate, not something the reviewer claimed to execute.

## Retained development failure history

- Initial codec and Python tests failed because their respective implementations did not exist.
- The initial test-only malformed-wire helper used JavaScript's numeric-key iteration, causing header-order errors before intended field tests. It was corrected to author FIX header order explicitly; production assertions were retained.
- Initial exact encoder/golden comparison exposed noncanonical fixture body ordering. Independent Python fixture construction was aligned with the documented canonical profile order; expected frames were not generated from TypeScript. Decoder still tests acceptance of noncanonical flat body order.
- A negative dictionary test incorrectly assumed Side=9 invalid in FIX4.4. The pinned dictionary correctly accepts that standard value; test changed to truly invalid Z. BUY/SELL-only is a stricter bilateral rule.
- Initial static checks found control characters in regexes and unnecessary assertions. Byte-aware checks replaced those regexes; lint rules stayed enabled.
- Review findings above failed dedicated tests before fixes. Environmental local launch/IPC/smoke failures remain recorded separately from successful checks.

The optional `git diff --check` reports upstream whitespace in the unmodified QuickFIX license. The vendored license is intentionally byte-preserved, with its hash verified; repository formatting and lint gates pass.

## Boundaries

No database mutation driven by FIX, inbox/outbox, protocol order creation, delivery, session replay engine, socket, pricing/execution engine, UI integration, hosted service, infrastructure edit, merge or deployment. CompIDs are fictional syntactic identities, not authentication. The independent dictionary checker is not an installed QuickFIX engine. Actual local interoperability remains unimplemented.

Phase3B1 should require separate approval for durable protocol ownership/correlation, protected capacity, fenced per-order command lanes, guarded existing-kernel entry points, versioned independent reconciliation and their real-PostgreSQL/security tests. It must not enable protocol-driven trading until the separately approved adapter milestone.
