# Phase4A Approved Preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Apply the owner's approved exact two-file exception and fully qualify/integrate Phase4A, then continue the approved Phase4 contract.
**Architecture:** Preserve the original manifest and strict verifier. A pinned version2 contract replaces only the two reviewed digests; both native callers load it and freeze its inputs.
**Tech Stack:** Python standard library; existing Node24/TypeScript/native engine/PostgreSQL gates.
**Spec:** docs/PHASE4A_REVIEW.md and the owner's November8 Yes accepting the Phase4 completion contract version1 and its exact two-file exception.

## Global Constraints

- Original preservation.json bytes/SHA256 d75f72090bafb12f51990bbe8e95aaba5a72c014fed291a3a8199c2303fc5f07 remain unchanged.
- Only app/server/fixed-income.ts and contracts/openapi.yaml receive the exact previously reviewed replacement digests.
- Keep verify_preserved strict; no fallback, general ignore rule, automatic current-hash acceptance, timeout/retry/capacity changes.
- Preserve all existing assertions, 43/89 standalone matrix and 118 live controls; add tampering coverage.
- No production deployment or real venue action.

## Review Focus

- Changing a third historical file must still fail.
- A replacement digest or preimage cannot approve itself.
- Changing/missing/symbolic metadata must fail closed.
- Both callers must freeze the new metadata and revalidate it at exit.
- Original uncertain-daemon cleanup assertions must retain their meanings.

### Task1: strict versioned preservation

**Files:** Create tools/fix-session/preservation-v2.json, tools/fix-session/preservation_v2.py, tests/preservation-v2/test_controls.py, tests/preservation-admission/test_admission.py and tools/fix-session/preservation_controls.py. Modify scripts/test-fix-session.py, scripts/test-fix-live-application.py, tests/fix-session/test_gate_controls.py and tools/fix-session/Dockerfile.
**Interfaces:** load_preservation(root: Path) returns version2 dictionary with exact434-file map; existing verify_preserved(root, files) unchanged.

- [ ] Write and observe new tests RED because the approved loader is missing.
- [ ] Implement fixed-digest metadata loader and literal exact-two-file overlay.
- [ ] Integrate both native callers; freeze new metadata, reload at final validation.
- [ ] Preserve existing daemon controls using authentic metadata fixtures and assert capture of new build inputs.
- [ ] Run all13 host admission/preservation controls and existing14 daemon controls GREEN; then all relevant required checks.

### Task2: full qualification and integration

**Files:** Update docs/PHASE4A_REVIEW.md, docs/PHASE4_ECONOMICS.md and docs/CURRENT_STATE.md with actual approval/results.
**Interfaces:** unchanged mandatory native gate contracts and source-bound evidence.

- [ ] Independent fresh review; fix material findings with RED/GREEN evidence.
- [ ] Full first-attempt local/hosted gates, native43/89 and live118, two full PostgreSQL passes and baseline/repeated three-browser work.
- [ ] Normal expected-head protected merge after all required gates and accepted exact scope.
- [ ] Verify resulting main gates, preserve first failures, record production pin unchanged.
- [ ] Continue approved4B-F without another routine permission loop.
