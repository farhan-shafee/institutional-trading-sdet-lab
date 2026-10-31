# FIX capacity-admission correction

Approved scope: one sibling correction from Phase3B2 `7d52f0882a97ee154b62a31f50d0f1037eb6a764`, not PR15. No merge, deployment, settings change or Phase3C.

## Capacity contract

For one sandbox, let C/E be actual financial command/audit counters, R/S be active reservations minus transaction-visible consumption, and H be `max(2 - retained rotation receipts since the first-ever retained FIX binding, 0)`. Authenticated rejected rotation receipts spend capacity too; original-key replay does not. Rotations before the first binding do not spend this protected allowance. Releasing a binding never moves the epoch forward.

BIND requires C+R+25+H <=512 and E+S+43+H <=1024, plus the unchanged lifetime four-binding bound. The universal counter trigger uses the same R/S/H, with the existing private rotation-context exception only. Consumption is visible before kernel execution, then proved against immutable APPLIED financial receipts/audits by the existing deferred COMMIT constraints. Do not require an application row prematurely in the arithmetic helper.

All 25 lifecycle command slots and 43 protected event slots remain reserved until actual effects consume them or safe pristine release retires the binding. A complete25-command41-event lifecycle leaves two conservative event slots outstanding. Eight fills and eight cancellation requests remain the limits. Actual counters are never reset or replenished.

## Implementation plan

1. Write PostgreSQL regressions using real financial commands/receipts; reproduce the exact net boundary (461+24+25+2=512) returning429 on007. Verify event-only boundaries using actual three-audit executions, not forged counters.
2. Add008 with a private owner-only capacity helper. Patch exactly one complete BIND fragment obtained from the current function definition; fail closed on unexpected source. Preserve007's protocol/application completion logic, OID, signature, ACL, owner and private financial kernel. Replace only the capacity trigger arithmetic. Preserve001–007 byte hashes.
3. Add schema8 financial metadata (`reconciliation-v4`) and current versioned FIX profiles/SQL. Keep historical schema5–7 variants, FIX v1 SQL/contracts/hashes and financial SQL unchanged. Add populated007→008 migration/replay/kernel/metadata evidence.
4. Exercise zero/partial/complete consumption, both resource boundaries, rotation/replay/release/rollback, twenty admissions, deterministic competing writer orderings, ownership, retained unresolved work and uncertain COMMIT recovery. Retain inherited crash, eight-fill/eight-cancel and historical verifier gates.
5. Run clean install/audits, static/contracts, independent Python/FIX, fresh PostgreSQL twice, normal and repeated three-browser suites; independent final source review and all four final-source push/PR workflows/eight jobs. Keep one unmerged PR on the approved base.

## Review focus

- Rotation receipts count financial spending, including rejected business receipts, without allowing forged rotation context.
- Earliest released binding remains the headroom epoch; releasing all active reservations does not recreate spent allowance.
- A concurrent manual writer and BIND serialize on the sandbox; whichever commits first determines remaining budget.
- In-flight consumption is necessary inside apply_fix, but incomplete or forged effects must still fail deferred integrity at COMMIT.
- Populated migration preserves all earlier completion-source changes and historical reports; schema8 is not a relabeling of old evidence.

## Integration boundary

PR15 changes reconciliation presentation; this branch changes capacity/migration/metadata. They remain independently reviewable. A separately authorized integration candidate must preserve both diffs, the security PR14 dependency remediation, all migration hashes and historical profiles; rerun their combined PostgreSQL and UI regressions on the actual candidate tree. No integration is authorized here.
