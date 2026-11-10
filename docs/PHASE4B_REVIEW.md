# Phase4B independent review and disposition

Reviewed range449b6186fade939f86e06515d24d029e618d2e97..0b91d64ffead486d6fd2177ef1efd4b33e930fbc. One fresh read-only reviewer inspected all changed code/tests/contracts/docs, the approved4B/shared requirements, plan and every ledger ruling.

No Critical or Important implementation finding. Implementation is ready for owner review, with one deferred Minor. It is not approved for protected merge: the unchanged preservation-v2 contract covers the earlier Phase4A bytes; both B native attempts correctly stopped with SOURCE_PRESERVATION. No deployment is authorized.

## Independently checked

- 162 endpoint round trips: three fixtures, three instruments and nine dates including coupon/leap/near-maturity boundaries; all passed.
- 40 prior OpenAPI paths and64 schemas structurally unchanged.
- 434 protected original files rehashed:432 unchanged, only the same two API files differ. Original manifest and v2 overlay unchanged.
- Actual full-gate logs/exits:1077 units,252 baseline and504 repeated cases, all exit0 on3f6cf1c.
- Both native failure receipts and relocated file hashes: SOURCE_PRESERVATION and owned cleanup true; no downstream native pass claimed.
- Authentication precedes calculation; duplicate/null-prototype query parsing and runtime schema boundaries inspected.
- Independent Python125 oracle, exact rational/Decimal80 calculations, cancellation, inversion and numerical ambiguity reviewed.

## Deferred Minor

OpenAPI3.0 represents four nodes as an array whose items each allow an approved offset. It cannot by that shape enforce the canonical ordered offsets365,730,1825,3650. The reviewer confirmed that four repeated day365 nodes pass the independent OpenAPI validator while runtime tuple validation correctly rejects them. Actual immutable factory output and trusted numerical consumption are correct.

Deferred: independent semantic duplicate/reordered-offset assertions and an explicit OpenAPI limitation annotation. uniqueItems alone would not enforce unique offsets. This is a response-checking gap, not a present pricing/security defect.

## Scope limitations and executor dispositions

| Reviewer limitation                                                      | Disposition                                                                                                                                                                                | Cost if mistaken                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Owner model/test and exact preservation acceptance                       | Remain human decisions; do not install new pins or merge under the Phase4A exception.                                                                                                      | Unauthorized acceptance would invalidate the source guard.                         |
| Successful B native qualification                                        | Not established; retain both real failures, require fresh full gates after exact source acceptance.                                                                                        | Downstream integration could remain untested.                                      |
| Fresh PostgreSQL/hosted/main/deployment outcomes not queried by reviewer | Parent separately verified A protected merge and all10 main checks; B introduces no SQL. Final C-F acceptance still requires two fresh full PostgreSQL passes and applicable hosted gates. | Evidence could be attributed to the wrong source if these boundaries were omitted. |
| Full suites inspected, not rerun by reviewer                             | Parent executed named commands and preserved their real exits; bounded independent reviewer probes supplement them.                                                                        | Finite recorded results do not prove all future environments.                      |
| Formal numerical/exhaustive proof                                        | Make only bounded engineering/oracle claims; preserve the explicit ambiguity refusal.                                                                                                      | An unexamined extreme could expose finite-precision limits.                        |
| Public ambiguity-band HTTP fixture not demonstrated                      | Retain the direct guard test and explicit safe mapping; do not invent a numerical HTTP fixture.                                                                                            | Rare error-mapping integration coverage remains limited.                           |
| C-F outside B                                                            | Continue the already-approved work; do not call B the whole Phase4.                                                                                                                        | Missing portfolio/storage capabilities would otherwise be concealed.               |
| Unsupported products/production behavior                                 | No live/editable curves, extrapolation, expanded trading eligibility, real settlement or hosted activation is claimed.                                                                     | Users could infer unsupported functionality if scope were overstated.              |
| Arbitrary forged internal cash-flow objects/prototypes                   | Public requests cannot supply these objects; future owned assessments must obtain inventory through the authorized database service.                                                       | A later internal caller could misuse an unchecked low-level helper.                |

The plan ledger retains the superseded wrapper-version decision and its observed RED/GREEN correction to original database IDs. No legacy definition was renamed. The rare numerical-error mapping remains an explicit test limitation. The authoring-helper lint failure was fixed by moving its unchanged bytes outside source; no lint rule or ignore was weakened.

No second review or optional Minor fix was performed. Final C-F integration and exact preservation acceptance remain separate.
