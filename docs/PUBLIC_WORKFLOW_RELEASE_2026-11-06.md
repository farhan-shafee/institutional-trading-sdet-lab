# Public institutional workflow release — November 6, 2026

The owner applied the reviewed production patch. The application reached terminal SUCCESS at **08:49:00 EST**. Chromium, Firefox and WebKit subsequently completed the real [public-domain workflow](https://tradeflow.farhan-shafee.com). This receipt concerns a synthetic engineering demonstration.

## Accepted source and deployment

| Item                                      | Observed result                                                                                                             |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Accepted PR                               | [#32](https://github.com/farhan-shafee/institutional-trading-sdet-lab/pull/32)                                              |
| GitHub-verified merge and deployed source | `b0216022cb8ff18de904efea9279c91b3977d55f`                                                                                  |
| Reviewed/deployed tree                    | `0312dae0a6fe0e9b3e460343dec9a0ac3f7cf5ca`                                                                                  |
| Main quality                              | [42221089925](https://github.com/farhan-shafee/institutional-trading-sdet-lab/actions/runs/42221089925), success, attempt 1 |
| Main persistence                          | [42221090065](https://github.com/farhan-shafee/institutional-trading-sdet-lab/actions/runs/42221090065), success, attempt 1 |
| Required checks                           | All 8 passed on first attempts                                                                                              |
| App deployment                            | `8d174084-7f30-40cb-a026-fa90f231c4a0`, SUCCESS                                                                             |
| Dedicated PostgreSQL deployment           | `00409675-9329-47b0-bb7a-0f53df5e3e0d`, SUCCESS, same source                                                                |
| Certificate-monitor deployment            | `4b4237ab-8ce0-4b06-8502-37d854660921`, SUCCESS                                                                             |
| Ingress                                   | Existing Cloudflare HTTPS and separate Railway cloudflared service; private app port 8080                                   |
| Capacity                                  | One app and one database replica, each 0.5 vCPU / 500 MB ceiling; dedicated 512 MB database volume                          |

The application uses the native Dockerfile, genuine Git objects and tooling. Reconciliation in all three browsers reported the exact merge, reviewed tree and CLEAN source state. Later documentation commits do not change this explicitly pinned app revision.

Both main PostgreSQL jobs passed **455/455**, with zero failures/cancellations/skips, 247 financial executions, 44 rotations and retained capacity returned to zero. The exact candidate additionally passed eight normal local qualification commands, 994 Node units, 230 baseline/460 repeated API/browser cases, 99/198 workstation cases, the real public image and the bounded interview journey. Those results belong to their named commands and revisions; they are not hosted load or availability guarantees.

## Actual public-domain acceptance

Each of Chromium, Firefox and WebKit passed:

- Fictional bond analytics: clean 99.875, accrued 1.0, dirty 100.875 and USD 1,008,750.00 consideration for USD 1 million par.
- Private workspace, 100.00 par RFQ, exact dealer quote `100.050000000123`, acceptance and order acknowledgment.
- 40.00 par execution, immutable 4002 consideration cents, signed cash -4002 cents and cancellation of the remaining 60.00 par.
- Historical reconciliation `COMPLETED_CLEAN` with genuine clean source provenance.
- Same workspace on reload and no horizontal overflow at 320 px.
- Independent viewer workspace, disabled trade controls, API mutation 403, cross-visitor read 404 and native ownership bootstrap 404.
- Repository, environment and server-source probes returned 404.

The published fake credentials remain `qa.user` / `Password123!`; `qa.viewer` demonstrates read-only access. Private bearer tokens, capability digests and configuration journals are excluded from this public record.

## Database and certificate operation

A fresh production-only database, owner nonce, five distinct credentials and CA were prepared. No preview secret or private key was reused. Three restricted runtime roles have separate credentials; the migrator/admin credentials are absent from the app.

Before activation, the authorized in-place database restart preserved the same deployment/image, volume, eight migration records/checksums, profile/database identity, five role properties, both instrument versions and all rows/digests in the synthetic RFQ/execution/cancellation fixture. A changed postmaster start timestamp established the real restart. That fixture had no reconciliation run; public-browser reconciliation was checked after activation.

After activation, independent read-only connections from the new app container verified `tf_app`, `tf_reconciler` and `tf_maintenance` using CA/hostname validation, authorized TLS 1.3 and profile checksum `cfa58430fe84656729eaf5fd0ed61db16da061927c619d9a336de4647dbbed32`. Wrong-CA and wrong-hostname probes had already been rejected before cutover.

The production leaf expires **February 4, 2027, 07:56:18 EST**. Its SHA-256 fingerprint is:

`0F:15:9B:2C:16:A3:5B:F3:53:D0:CB:DE:70:63:A0:74:65:66:AD:08:49:4C:63:CD:9E:7C:E9:53:43:34:DA:01`

The credential-free certificate function is deployed on Bun 1.4.4, daily `0 14 * * *` UTC (**09:00 EST** on this release date), restart NEVER, 0.25 vCPU / 250 MB. It verifies the PostgreSQL SSLRequest response, CA and hostname before closing without authentication or SQL, and reports warning/nonzero at 35 or fewer days remaining. At the initial post-deploy read, its first scheduled production execution had not yet occurred. The same probe had independently passed from the existing app container; initial execution is separate from schedule configuration. Notification delivery is not claimed.

The image renews its 90-day leaf on startup when fewer than 30 days remain, preserving the CA. Renewal/restart remains owner-controlled; no unattended renewal or high availability is promised.

## Public policy, rollback and evidence limits

Writes end 30 minutes after workspace creation; records are eligible for cleanup after 60 minutes, subject to existing lease and failure rules. Access ends with the original synthetic session, logout or app restart. These are separate clocks; there is no public ownership recovery. Local seven-day/thirty-day ownership behavior is unchanged.

The previous equities release `265c9e0ed1fdc528193cd474d966513decd03d3b`, deployment `30ca206b-765b-4fe5-ad22-50a1f2d02aec`, and exact old app configuration are preserved for rollback. Restore the old builder/source/configuration and remove all five `TRADEFLOW_PUBLIC_DEMO*` settings; activation off alone is insufficient. Preserve the new database/volume. A preview rehearsal rebuilt the exact old source; it did not redeploy the retained production artifact.

Two deployment-confirmation attempts were declined before the owner applied the patch directly. They made no live change and were not bypassed. The GitHub review bot's earlier quota failure remains disclosed; supplemental independent AI review found no critical/important defect, with a minor immutable-evidence-link gap recorded. The owner accepted the behavior/release. No branch protection, account credits or review policy was changed.

Original intermittent local startup/SQL-limit failures remain retained. The narrow SQL rewrite passed 756 same-snapshot equivalence comparisons and complete qualification; later passes do not establish the original startup cause. No assertion, timeout, retry or financial rule was weakened.

No broker/exchange connection, live feed, real trading, settlement, real-money P&L or regulated-platform claim is introduced. FIX remains bounded application-message tooling and offline session conformance, with no runtime session engine or peer interoperability.

See [current state](CURRENT_STATE.md), [production runbook](RAILWAY_PRODUCTION.md) and [public profile contract](PUBLIC_WORKFLOW.md). Raw owner-device evidence is under `evidence/production-release-20261106`; private journals remain outside public source.
