# Phase 4 economic contracts

Status: owner approved the finite financial scope and exact Phase4A two-file preservation exception on November8,2026. Implementation continues against [the approved completion contract](PHASE4_COMPLETION_CONTRACT.md); native qualification/integration and later implementation evidence remain separate. No deployment is authorized.

## Delivery boundary

Build the recovered 4A-4F roadmap in sequence. Each slice has its own finite written contract, additive implementation, independent numerical or accounting evidence, and compatibility checks. Do not label a completed slice as the entire Phase 4. The default target is inspectable synthetic engineering work in local/CI. Public deployment is a separate release decision.

Preserve existing formulas, the two original instrument IDs and response shapes, historical immutable receipts, migration checksums, financial capacity reservations, authorization and owned cleanup. Do not edit historical migrations or regenerate historical golden expectations. No new network venue, real feed, brokerage account, real funds or actual securities settlement.

## 4A: additional zero-coupon structure

The new versioned model is `ZERO_SIMPLE_ACT365F_V1`. It deliberately uses simple annual yield over actual calendar days divided by 365; it is a synthetic convention, not Treasury bill, STRIPS, tax or market-standard yield certification.

Instrument `SYN-ZERO-2031`, definition version `SYN-ZERO-2031_V1`, fictional USD issuer "Fictional zero-coupon reference", dated 2025-01-15, maturity 2031-01-15, no periodic interest, one principal payment of 100 per 100 par on maturity. Definition and model identities are returned on every calculation. Definitions are deeply immutable.

Settlement is a strict Gregorian date in [dated date, maturity). Coupon accrual is always zero. There is exactly one remaining payment. Let d be the integer UTC calendar days from settlement to maturity, t=d/365, y the annual decimal simple yield. Dirty and clean price per 100 are both 100/(1+y*t). The discount denominator must be positive. Inverse yield from clean price P is (100/P-1)/t. No holiday adjustment, stubs, embedded options, credit/default, inflation, FX or tax.

Inputs are strict decimal strings: par 1 through 1000000000 with at most 2 fractional digits; yield [-0.10,1.00], price (0,10000], at most 12 fractional digits. Exactly one of yield or clean_price. No unknown/repeated fields or scientific notation. A quoted price must imply a yield inside the supported bracket; allow at most half a displayed price quantum at bracket boundaries and clamp only that wire-rounding error.

Output: prices and accrued interest 10 decimals, yield 12, par and cash 2. Isolated 50-digit Decimal HALF_EVEN calculations for displayed values. Cash is rounded exactly once with integer rational quotient/remainder arithmetic, including exact half-cent ties. Do not derive cash from displayed price or rounded inverse yield. Quote mode uses the exact supplied quote; yield mode uses its exact rational simple-discount price.

This is an additive authenticated read-only v2 catalogue and analytics capability. The existing v1 catalogue remains exactly two instruments, and v1 responses/calculations remain unchanged. Both roles may calculate. No order/RFQ writer is extended to claim the new instrument is tradable. New-instrument trading is outside this first slice and must be explicitly disposed of in final Phase4 scope review.

Exit: actual cash-flow schedule, forward/inverse and exact cash goldens, invalid-date/domain/boundary rejection, runtime immutability, separate Python Fraction oracle, authenticated HTTP/OpenAPI contract, existing analytics and baseline regression preservation.

## Remaining required slices

These remain required and unfinished until implemented and verified; the outline below is historical planning context. The authoritative finite rules are now owner-approved in PHASE4_COMPLETION_CONTRACT.md.

- 4B: versioned synthetic USD discount factors, ACT/365F time, log-linear discount-factor interpolation, no extrapolation, continuous spread, independent DF/PV/spread goldens. Preserve scalar v1 YTM.
- 4C: portfolio risk from owned authoritative positions and versioned curve/instrument snapshots, signed PV/DV01, named key-rate and nonparallel stress scenarios, honest unavailable state for missing marks. Define finite bumps, sign and tolerance before implementation.
- 4D: append-only corrections and busts referencing immutable executions, atomic receipt/audit/projection, original-key idempotent recovery, concurrent writer and uncertain-COMMIT evidence. Define eligibility, temporal/restatement and settled-trade policies plus exact reserved capacity before a writer.
- 4E: separate synthetic settlement obligations, funded cash/securities, explicit calendar/cutoff and pending/settled/failed/reversal states, conservation and no double posting. Execution cash is not settled cash. Define funding, short, partial and coupon/principal scope before a writer.
- 4F: versioned marks and FIFO basis including short/cover, realized/unrealized P&L and correction/settlement bridges. Define dirty/clean/accrued, realization, fees, FX and restatement policies before implementation.

Final closeout still requires cross-phase integration, security/resilience, operational recovery/cleanup, fresh complete PostgreSQL passes and all applicable first-attempt gates on one identified source, independent review, human scope acceptance and explicit deployment disposition. No earlier green run substitutes for this final evidence.

## References

- [TreasuryDirect STRIPS history](https://www.treasurydirect.gov/research-center/history-of-marketable-securities/strips/): principal-only instruments demonstrate a different cash-flow structure from coupon bonds; our named simple-yield model makes no STRIPS convention claim.
- [OpenGamma Strata discount factors](https://strata.opengamma.io/apidocs/com/opengamma/strata/pricer/DiscountFactors.html): conceptual reference for the later separate curve model, not application output or an independent oracle.
