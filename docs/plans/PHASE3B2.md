# Phase 3B2 implementation plan and evidence ledger

> Execution: superpowers:executing-plans; one independent final source review.

Goal: atomically apply controlled local FIX evidence through the unchanged financial kernel, preserving original economic identities. Spec: the explicit Phase 3B2 approval in the project conversation; this plan records implementation choices within that approval.

## Preflight (executed before branch creation)

Approved parent 442ebb9fdefafa9ad45eac0929355b4e1753c101, tree c90be9c94dd0c383bf439cc7a104d1b7b0773689. PR6–12 all open/unmerged, approved heads/bases unchanged; continuous ancestry verified with git merge-base. Migrations001–006 match the runtime contract, including006 c1875a97891c045bf57ba9e08c27df44672dbabe10fd386c70e18b0b91fa8f46. Four final-source runs41146977692/41147014481/41146977695/41147014513 and all eight jobs succeeded first attempt; logs inspected. No material unresolved blocker.

Inspected private unchanged order_command_kernel and guarded same-OID public function, prepared payload/hash, immutable metadata-only outcomes, shared command-key registry, reservations, immutable raw/semantic correlations, lane fencing and independent reconciliation. Prepared hash is SHA256(PostgreSQL JSONB payload text); financial fingerprint is SHA256(the compact, ordered JSON request envelope used by OrderService). They must remain distinct and explicitly linked. Kernel inserts reserve a shared key: promotion must UPDATE its existing row only under private transaction context; never delete it. The current metadata outcome cannot be upgraded in place.

## Architecture and decisions

Use additive007 and new append-only application/outcome/capacity evidence; preserve006 objects/history. The public financial signature and byte-identical private kernel stay authoritative. Private application context permits only the exact prepared key/request; triggers verify the committed financial receipt, actual history/audits and consumption at transaction end. No new financial calculator. Lock order: sandbox, lane, order state, key/evidence. Other writers already serialize at sandbox. Financial effects, key promotion, reservation consumption, protocol outcome and command receipt share one transaction.

Ruling: use a separate immutable applied-outcome table, retaining metadata-only outcomes unchanged — avoids relabeling old evidence; costs one explicit union of lane completion sources.
Ruling: consume immutable1-command/1-or3-event entries before the kernel counter update, with deferred effect validation — protects all writers without a release window; a failed statement/transaction rolls everything back.
Ruling: preserve old financial v1/v2 and foundation-v1 profiles; add financial schema7 metadata and distinct protocol-application-v1 — no historical result claims new coverage.
Ruling: contradictory valid reports remain durable unresolved lane heads; unsupported wire/profile input is rejected without trusted-message creation — preserves the approved codec profile, no inferred effects.

Limits: feature OFF by default; internal opt-in SDK only; owned local/CI PostgreSQL, no HTTP/socket delivery, no SENT/DELIVERED claim, no network/session engine.25/43 reservation budget,512/1024 financial limits,4 bindings,8 fills/8 cancellations,40 messages/work per order,4 attempts, existing leases/deadlines/retention/security headroom. No earlier migration/PR modifications; no merge/deployment/other repositories.

## Tasks and file boundaries

- [ ] 1. Real PostgreSQL RED tests for007: migration/kernel identity, key promotion, atomic ACK/fill, replay and effect-backed capacity. Implement `db/migrations/007_fix_application.sql`, internal `app/server/fix/application.ts`, versioned `contracts/fix-application-v1.yaml`. Extend runtime schema checksums and historical metadata union. Run new targeted plus inherited PostgreSQL suites.
- [ ] 2. Ordered report validation and cancellation: report/ledger totals, pending-cancel precedence, ambiguous rejection blocking, common-price model, no inferred fills. Test twenty competing applies, deterministic both race orders, invalid correlations and original prepared identity recovery.
- [ ] 3. Independent `verification/sql/fix_application.sql` and authenticated snapshot verifier, financial SQL in same snapshot, Python byte/cash cross-checks; deliberate corruption, watermarks and deterministic transcripts for both conventions and signs.
- [ ] 4. Real process/connection/COMMIT/database restart, logout/rotation/fence, reservation quota, least privilege, populated006 upgrade, maintenance cleanup and feature-OFF regressions.
- [ ] 5. Static/units/financial/FIX/API/contract/three-browser and repeated PostgreSQL/browser gates; independent whole-branch review and RED→GREEN material fixes; final source push+PR CI; exact tree/commit inventory and evidence report.

## Review focus

- Public/manual key replay cannot bypass FIX ownership or private promotion context.
- Metadata-only or duplicate observations cannot consume capacity or claim an economic effect.
- Pending-cancel status is separate from local financial status and from transmission intent.
- Incomplete/uncertain heads preserve identity and block subsequent actions after fencing/restart.
- A clean observed application snapshot cannot imply delivery, external completeness or historical foundation verification.

## Rollback/integration

Later approved review sequence: PR6→7→8→9→10→11→12→this PR, revalidate entire populated migration stack and full tests at approved integration points. Do not retarget/rebase now. Roll back runtime enablement with a schema-compatible build; retain007 evidence and unresolved keys. Older optional persistence binaries intentionally reject unknown schema versions. No destructive database downgrade.

## Executed evidence and retained failures

Baseline TypeScript115/115 passed. Further execution evidence appended below; unchecked tasks are not claims of success.

Independent final source review: three Important findings, no Critical/Minor. The reviewer independently reproduced all three on a separate owned ephemeral PostgreSQL and destroyed it. Root regression run reproduced3/3 failures: (1) legacy metadata completion bypassed contradictory head, (2) protocol-only observation COMMIT accepted expired fence, (3) matched wire/semantic pending OrdStatus corruption produced no SQL finding. One consolidated fix pass: validated completion required for application lane progress (old immutable metadata retained), stored observation fence/generation plus deferred COMMIT validation, and independent pending status/AvgPx semantics. Each focused RED→GREEN and the combined3/3 green run executed. No second review or claim of reviewer acceptance of the final source.

Final review rulings: final full gates/hostedCI/dependency remediation/browser behavior were explicitly outside the reviewer's executed evidence; root owns and reports those gates separately. Deployment/merge readiness remains a human decision and is not claimed. No deferred minor findings.

Local limitations retained: literal validate after audit remediation passed audits/static formatting then hit tsx Unix IPC EPERM at contract:validate; direct node --import tsx contract/workflow/financial/FIX/build components executed separately. Literal repeated legacy browser launch hit the same tsx IPC restriction. Initial workstation run attempted42 tests but could not launch absent browser executables; browser installation attempted separately. Direct production smoke invocation was correctly rejected by its existing npm-lifecycle guard (not reported as passed). No timeout/retry/assertion policy changed.

Publication preparation: local typecheck/lint/format and117-unit gate passed on corrected code. Full corrected PostgreSQL216/216 passed, zero failures/skips, fresh owned retention count0. Independent finance gate executed39 Python discovery cases and70 HTTP cases (54 financial); separate FIX gate7 Python tests/14 TypeScript-encoded golden frames. Eight new actual-database transcript cases cover both instruments/sides and coupon/leap-day cash. Independent SQL additionally executed after partial-cancel and full-fill/too-late transcripts. Final repeated fresh-source PostgreSQL and hosted push/PR evidence are recorded in the PR completion report; do not infer hosted success from this pre-publication ledger.

Browser installation failure retained: playwright CDN returned invalid/truncated ZIP archives; no local cross-browser pass is claimed. Mandatory unchanged hosted workflows execute the full browser gates against the final source. Historical foundation/reconciliation contracts, prior PRs and migrations001–006 remain untouched. New protocol-application assessments are read-only snapshot results, not a new durable assessment UI/history; existing financial assessment history remains durable.
