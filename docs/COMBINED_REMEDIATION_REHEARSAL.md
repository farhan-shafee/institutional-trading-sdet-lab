# Combined remediation integration rehearsal

This is an isolated, default-OFF local/CI candidate. It authorizes no existing PR merge/retarget, main update, governance change, retained-database migration, deployment, FIX session or new financial feature. Exact final source identifiers, executed results and final-source Actions links belong to the draft PR completion report; historical individual PR results do not certify this combination.

## Source and preservation contract

Start: PR16 c98fd4e6930545b1e6de95e30df2fe1771779f4f, tree7245f58dd24f95c778063069cac60bfa47299598. Merge PR15 head8266a33af0badabf36cd36d264babf33dd5e7910 with an ancestry-preserving non-fast-forward merge. Ordered parents must remain exactly those two heads. All five PR15 commits and the original PR16 commit remain ancestors. Their common base is Phase3B2 7d52f0882a97ee154b62a31f50d0f1037eb6a764.

The pure union contains24 changed paths relative to Phase3B2:20 from PR16 and4 from PR15, with no path overlap. Each imported path must equal its reviewed sibling blob exactly. The pure union tree is8e0aeeae29cc0719db371bb2988cfe36d60f9d16. The only planned integration-only additions are this record and the rehearsal plan; no runtime adjustment is assumed necessary. Final evidence must explicitly identify any later adjustment.

Immutable RFQ-accepted orders, dealer quotes, the financial command kernel, execution/position history, RLS, fencing, prepared identities, original-key recovery and synthetic FIX evidence stay intact. Migration008 remains the database authority for actual effects plus unconsumed reservations, new25/43 capacity and finite security headroom. PR15's selection/session/generation, staged findings, trace ownership and independent error sink run against the schema8 domain contracts inherited from PR16. Historical schema5–7 profiles keep their original meaning.

## Security convergence

Read-only preflight verified PR14 head685766edb8ff355f1da5d57738c28a1b37c1e40a on main, open/unmerged. Phase3B2 and both siblings already contain its minimatch11.0.1 override. The candidate package/lock must remain byte-identical to Phase3B2; do not overwrite the evolved feature lockfile with PR14's older complete lockfile.

Actual npm ci and npm ls must prove every minimatch reference resolves to11.0.1. The lock entries for minimatch11.0.1, @isaacs/nonrecursive-glob-match1.0.3, brace-expansion5.0.12 and balanced-match4.0.4, including resolved URLs and integrity hashes, equal PR14 exactly. Clean installation verifies package integrity. Both full and production audits must report zero known advisories at execution; this is not a guarantee against future advisories.

## Migration and verifier identity

| Version | SHA256                                                           |
| ------- | ---------------------------------------------------------------- |
| 001     | d80960349926e30d7d15dde0a10156a82c45221fe18b733c49c7bee01615ebc6 |
| 002     | ab835535496e2772a82f5c1910dc025141c543e7480c001c0d3a793a59e1c117 |
| 003     | 0e27140069d5394d942493c693b1ca5b723d45781a145c2dedc3dd10b4eddaa5 |
| 004     | 31a65e83f64fcc0c91939d1512e2d2c9e427401bd699a62c827ceb5f30f1a4a1 |
| 005     | 23aa546de2c37bcfe5abbaec122ac068db78d9eb8dae257649f675c2b144d99e |
| 006     | c1875a97891c045bf57ba9e08c27df44672dbabe10fd386c70e18b0b91fa8f46 |
| 007     | 91c8355e7a3fe1601e91093081f0f215e5a739346472888c9f284e084affb16d |
| 008     | 1f994a04d94b190cac22e6c125542e7f95cc27eadd7d7ecd32bc7383d9b41a17 |

All eight source files and the checksum manifest must match PR16 exactly. Migrations001–007 additionally match approved Phase3B2. All four financial SQL files and historical FIX v1 SQL/contracts remain byte-identical. Current financial reconciliation-v4/schema8 and FIX v2/schema8 verification are distinct from retained historical evidence. Populated007→008 must preserve row hashes, receipts/replay, prepared identities, function identity/privileges, private kernel body and completion-source ordering. Controlled-corruption cases must detect violations independently of the runtime helper.

## Required executed gates

Run119 units,236 real PostgreSQL tests twice on fresh owned instances,99 workstation executions and198 repeats across Chromium/Firefox/WebKit,230 normal legacy API/browser executions and460 repeats, financial Python/HTTP and FIX byte/dictionary verification, static/contracts, clean audits, build and native production-artifact smoke. Existing99 workstation tests include all originally failing selection races; capacity tests include20-admission concurrency, real committed receipts, limits, rotation/release, rollback and uncertain COMMIT recovery. Additional tests, if any, are reported separately.

Record four final-source push/PR workflow runs and all eight job logs, attempts, actual counts, skips, retry markers and cleanup. Retained capacity must return to zero for every owned database run. Separate local tool/environment restrictions from hosted canonical results. No historical individual PR success can fill a missing combined gate. Fresh independent whole-candidate review must examine metadata/UI, transaction/capacity, recovery, security and SQL interactions.

## Later controlled integration recommendation

Preflight observed main unprotected and rulesets empty. No governance action was performed. Even a completely green rehearsal is therefore CONDITIONAL GO for a separately approved controlled integration, not release acceptance.

1. Obtain separate governance/integration approval. Before any main merge, confirm the production source pin prevents automatic deployment; if it does not, obtain separate authorization for a release guard. Keep production unchanged throughout source integration.
2. Under that approval, protect main against direct/force pushes and deletion; require PRs, resolved discussions, current-base checks and independent human review with stale approvals dismissed. Require the four distinct GitHub Actions job contexts quality, postgres, workstation and regression from the expected app. Eight push/PR executions are evidence, not eight unique context names. Establish a reviewer who can actually satisfy approval requirements; do not silently bypass them.
3. Merge securityPR14 first using a merge commit after fresh source/audit checks. Preserve its ancestry and security intent. Reconcile each later feature's dependency graph against it; resolve any package/lock conflict surgically, regenerate only if justified, and rerun clean npm ci, npm ls and full/runtime audits. Never restore an older entire lockfile.
4. Integrate PR6 throughPR13 bottom-up with merge commits. After each ancestor is in main, separately authorized retargeting of the next PR to main can expose only its own delta; rerun checks against the actual new main. Do not rebase/squash away original history or merge successors into old feature branches. Review migration hashes and kernel invariants at each phase.
5. Once Phase3B2 is an ancestor of main, integrate PR16 thenPR15 to match this rehearsal's order, using separately authorized PR retargeting/merge commits and fresh checks. The rehearsal PR remains evidence, not an additional duplicate route for importing the same fixes. Preserve both original histories and documentation.
6. Revalidate the actual combined main candidate with all236 PostgreSQL tests twice,99/198 workstation executions,230/460 legacy executions, independent financial/FIX/SQL/security/build/recovery gates and fresh source review. Main's added security/integration ancestry changes source metadata; this rehearsal alone does not certify that later tree.
7. Stop before deployment, hosted FIX enablement and Phase3C. Operational/release acceptance and every roadmap step require separate authorization.
