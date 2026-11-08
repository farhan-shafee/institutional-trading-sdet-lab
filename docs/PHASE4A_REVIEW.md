# Phase 4A candidate review

The owner accepted the proposed model and exact two-file API exception on November8,2026. Versioned preservation implementation and complete native qualification now proceed within that approved scope. Production deployment remains separate. The pre-approval review record below is retained as historical evidence.

## Pre-approval review record

This is a reviewable candidate, not an accepted Phase4 completion or production release.
The remaining Phase4B-F contracts and final cross-phase closeout are still open.

## Concrete model decision

Accept or revise the separate `ZERO_SIMPLE_ACT365F_V1` convention in
[PHASE4_ECONOMICS.md](PHASE4_ECONOMICS.md): one fictional USD principal-only
redemption, simple annual yield, actual calendar days/365, exact rational cash
rounded half-even once. It adds no new trading eligibility. Existing coupon
bond definitions, calculations and v1 responses remain unchanged.

The implementation includes an independent Python Fraction oracle and real
authenticated HTTP/OpenAPI tests. The candidate passed all1046 unit tests and
all10 new service API tests, plus typecheck, lint and OpenAPI validation.
Full local validate passed with240 baseline browser/API cases; the repeated
three-browser/API run passed480 cases with retries0. The final unit suite
passed1046/1046 after adding a69th independent oracle case and a literal
large-par penny regression. A deliberately displayed-price cash mutant failed
the two new assertions; the unchanged real calculation passed.

Independent review found no current calculation/security defect. Its Important
cash-regression coverage gap is fixed. One Minor item is deferred: committing
the four near-maturity half-quantum boundary cases. The reviewer executed those
four cases and4382 endpoint round trips successfully; this is executed probe
evidence, not committed regression coverage.
These are executed slice-level results; complete final-source qualification
is not inferred from them.

## Exact preservation decision

The existing native FIX gates enforce byte preservation for434 historical
files. The proposed additive API integration changes exactly two:

| File                       | Historical SHA256                                                | Candidate SHA256                                                 |
| -------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| app/server/fixed-income.ts | a12cc4c7168aa2faacbc9c0adcc3902faae8b1f2a12b2ca8d1ad18f5e646a6b5 | cca68918c45ecac3fce25649211466b30a1dc76c7759e89656ded72a5868fcf6 |
| contracts/openapi.yaml     | 4648c000f86b5eb4bd0838755e7bc4971ffc09903391e1249ed10ce03ed4dd17 | dfb15fb8ddef03b35950c9fdb1276e860a280bf111209ea2164341b5522154c9 |

All other432 protected files still match their original hashes. The historical
manifest, verifier, native controls, deadlines, resource limits and financial
writers are unchanged. Running the current preservation verifier on this
candidate correctly returns `SOURCE_PRESERVATION`; the two full native gates
therefore remain blocked on this source. No exception has been installed.

The proposed exception is limited to the two named files and their exact
reviewed additive v2 route/schema changes. A future approved versioned
preservation contract must retain the historical manifest and all other
original hashes, bind the reviewed replacement bytes, and retain negative
tampering controls. It must not create a general ignore pattern or accept
arbitrary new file hashes. Fresh full native qualification is required after
that approved integration; historical passes cannot qualify this candidate.

Repository AGENTS.md states:
"Behavior changes and generated tests require human review before acceptance.
Authorized implementation can proceed so the reviewer has a concrete diff
and evidence."

The Phase3C roadmap also explicitly requires owner approval for needed
model/verifier extensions. The candidate is prepared for that review without
altering those acceptance gates. No merge, deployment, hosted migration or
real venue action is included.
