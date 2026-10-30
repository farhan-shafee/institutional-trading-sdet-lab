# Phase 3A execution plan and evidence ledger

Approved base: 9dee9cdcf10be5e8a751d3b8f4f1b9dd5a9113d4; tree 0b1170f254bff4dbdc5445412d3c409e8c85d0da.
Scope: four-message bounded byte codec, bilateral contracts, independent protocol verification only. No financial adapter, schema changes, sockets or deployment.

1. Freeze independently constructed SOH fixtures, write failing codec tests.
2. Implement focused byte framing, profile validation, deterministic encoding and bounded stream parsing.
3. Add independent Python byte oracle and pinned QuickFIX FIX44 dictionary-driven checker with negative controls.
4. Document tag/standard/profile boundaries; add mandatory protocol gates without weakening existing gates.
5. Execute targeted and complete regression gates, fresh independent review, correct material findings, commit/push and open stacked unmerged PR.

Shared interfaces: manifest fields exclude derived framing tags 8/9/10; encoder adds them. Decoder returns only fully validated messages. Python reads raw fixtures and XML directly, never imports TypeScript.

Ruling: the external standard layer uses an independent Python dictionary-driven checker over the unmodified pinned QuickFIX XML, not an installed QuickFIX session engine. Phase 3A needs dictionary validation, not session interoperability. No engine/interoperability claim follows from this gate.

Baseline: npm ci succeeded. Literal npm run test:unit failed before assertions because tsx CLI's IPC socket was denied (EPERM). Direct node --import tsx --test tests/unit/*.test.ts executed all 84 baseline checks successfully. Hosted literal commands remain mandatory.

Task1–4: complete —14 independent SOH goldens; bounded isolated codec/profile; independent Python and pinned base QuickFIX XML checker; mandatory additive gates/docs. Final local unit suite113/113 and FIX gate7 Python tests/14 encoded frames passed.

Final review: independent fresh-context source review. Three findings reproduced RED→GREEN: impossible prefix classification, common retransmission validation before unsupported type, and independent Python shortened-date acceptance. The third was regraded material because it weakened independent validation. No deferred minors. Financial/domain/HTTP/DB code remained unchanged.

Local regression:138 PostgreSQL cases passed, retained capacity zero; financial HTTP verification passed. Literal validate/repeated legacy browser commands blocked by existing tsx IPC EPERM; local workflow-browser cases could not launch absent browser executables; direct smoke correctly refused non-npm invocation. Full hosted literal gates remain required. See docs/PHASE3A_VALIDATION.md for retained failure history and scope limitations.
