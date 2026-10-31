# FIX capacity-admission evidence

Approved baseline: Phase3B2 `7d52f0882a97ee154b62a31f50d0f1037eb6a764`, tree `aee7e47c906526402e0074c78810dcbb401effdd`. This sibling correction does not include PR15's reconciliation presentation changes. No merge, deployment, hosted database, settings change or later phase is authorized.

## Reproduction before008

The merge-readiness audit identified a source-level mismatch but did not execute a reproduction. The unchanged baseline then passed216/216 real native PostgreSQL17.10 tests. New receipt-backed tests executed against unchanged007 before008 was written:16 cases,8 passed,8 failed,0 skipped/cancelled.

| Genuine committed state                                                | Correct admission arithmetic                                                    | Old BIND result              | Required result |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------- | --------------- |
| C461/E470; consumption1 command/1 audit                                | 461+24 remaining+25 new+2 security=512 commands                                 | 429 FIX_RESERVATION_CAPACITY | 201             |
| C485/E510; full consumption25 commands/41 audits                       | 485+0 remaining+25 new+2 security=512 commands                                  | 429                          | 201             |
| C378/E940; consumption2 commands/4 audits including a three-audit fill | 940+39 remaining+43 new+2 security=1024 audits; command budget remains below512 | 429                          | 201             |

Every primary fixture verifies actual counters equal committed receipt/audit row counts. Quotas are filled with actual financial rejection receipts and real executions; primary tests never falsify counters. Zero-consumption admission at the exact boundary already passed, and one-over512/1024 requests already returned429. The remaining expected RED cases covered20 net-boundary contenders, finite rotation/release headroom, BIND-first competing manual writer, and original-key recovery around/after COMMIT. No assertions were removed or statuses reclassified.

## Database contract and migration

Effective admission is C+R+25+H<=512 and E+S+43+H<=1024. R/S subtract actual transaction-visible consumption from active reservations. H=max(2−retained rotation receipts since the earliest-ever retained FIX binding,0). Authenticated rejected rotations spend capacity; replay, rollback and pre-auth failures add no spending. Pre-first-binding rotations remain outside this protected epoch.

Release cannot move the epoch forward or recreate spent headroom. A full25-command41-audit lifecycle still retains two conservative audit slots. Lifetime4 bindings,8 fills and8 cancellation requests are unchanged. The private helper is owner-only SECURITY INVOKER; only existing authenticated definer entry points use it. The all-writer trigger/private rotation-context exception and deferred effect-backed COMMIT constraints remain authoritative.

008 patches exactly one expected BIND fragment from the installed007 function, failing closed otherwise. Tests compare function OIDs/owner/ACL/definer/configuration, unchanged private kernel body, nonempty preservation of all other command-body lines, retained rows/prepared keys/replays and application/protocol-only completion ordering. Populated007→008 and rerun pass; unexpected installed source rolls008 back entirely.

| Migration | Unchanged SHA256                                                 |
| --------- | ---------------------------------------------------------------- |
| 001       | d80960349926e30d7d15dde0a10156a82c45221fe18b733c49c7bee01615ebc6 |
| 002       | ab835535496e2772a82f5c1910dc025141c543e7480c001c0d3a793a59e1c117 |
| 003       | 0e27140069d5394d942493c693b1ca5b723d45781a145c2dedc3dd10b4eddaa5 |
| 004       | 31a65e83f64fcc0c91939d1512e2d2c9e427401bd699a62c827ceb5f30f1a4a1 |
| 005       | 23aa546de2c37bcfe5abbaec122ac068db78d9eb8dae257649f675c2b144d99e |
| 006       | c1875a97891c045bf57ba9e08c27df44672dbabe10fd386c70e18b0b91fa8f46 |
| 007       | 91c8355e7a3fe1601e91093081f0f215e5a739346472888c9f284e084affb16d |

008 SHA256: `1f994a04d94b190cac22e6c125542e7f95cc27eadd7d7ecd32bc7383d9b41a17`.

Current financial metadata is reconciliation-v4/schema8 with eight checksums. Current FIX v2 profiles report schema8 and independently check effective capacity. Historical schema5–7 metadata, FIX v1 contracts/SQL/hashes and all four financial SQL sources remain unchanged. Legacy FIX result projections are compared before/after migration, and the stored schema7 request/metadata/replay remain unchanged. Foundation-only assessment does not certify financial application; observed applications use the application verifier.

## Review and retained development evidence

Independent whole-diff review confirmed the budget/epoch/security/migration design and ran40 targeted real PostgreSQL tests successfully on a fresh owned instance. It identified incorrect v2 contract labels/SQL pointers and stale current documentation; these were corrected. A proposed newline/vacuous-comparison finding was withdrawn after byte-level verification showed the source correctly used a newline; the comparison was nevertheless strengthened to require exactly two removed lines and over80% retained source.

Secondary controlled-corruption verifier tests initially violated the existing command_count=commit_seq CHECK, then exposed PostgreSQL integer/bigint parameter deduction. The fixture now changes both columns with an explicit integer cast. No CHECK was disabled/dropped and no verifier assertion was weakened. These adversarial fixtures are separate from the genuine receipt-backed admission proof. Both current SQL verifiers detect command/event capacity corruption.

COMMIT-loss tests now require their actual fault hook to be reached, reject setup/schema errors, preserve exact original requests/keys and verify authoritative replay. A development run begun before runtime metadata moved from7 to8 demonstrated why a generic503 assertion alone was insufficient. Around-COMMIT connection termination may be observed before or after client dispatch; only DATABASE_UNAVAILABLE/OUTCOME_UNKNOWN are accepted, with authoritative non-replay required. Confirmed-after-COMMIT loss requires OUTCOME_UNKNOWN and original replay.

The corrected independent reviewer rerun passed4/4 migration/verifier tests on another fresh owned instance, retained capacity0, with no remaining material source findings. The prior40-test run and corrected metadata2/2 run are retained; they do not substitute for final-source full gates.

## Verification boundaries

Local PostgreSQL uses17.10 binaries installed solely as isolated test tooling outside the repository. The original216-test baseline and pre-review234-test candidate passed; final expanded suite contains236 tests. Local static/contracts,119 units, financial39 Python discovery/70 HTTP cases, FIX7 Python/14 frames, production build, full/runtime audits and80 browser-free API/contract cases are verified separately from hosted canonical execution. Final full/repeated totals and all four source-specific Actions links are recorded in the PR completion report.

The container blocks the tsx CLI Unix IPC socket and the matching Playwright browser download failed. Canonical local validate/repeated-browser attempts remain execution restrictions, not passing results. Hosted CI must execute the unchanged canonical commands. This branch retains the inherited42 workstation executions and84 repeated executions, not PR15's new UI regressions.

## Later integration

Keep the capacity PR unmerged and based on the approved Phase3B2 branch. A separately authorized integration candidate must preserve PR15's UI/error/session-generation changes alongside this migration/domain/metadata change and PR14's dependency remediation. Never replace an entire dependency lock from an older phase. Verify migration001–008 checksums and both historical/current profiles, then rerun combined236 PostgreSQL cases and PR15's complete reconciliation race suite on the actual integrated tree. Recheck the resulting dependency graph and release/recovery gates; no merge or production authorization is implied here.
