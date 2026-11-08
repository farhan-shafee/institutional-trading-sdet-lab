# Phase4B synthetic curve analytics

This local/CI candidate implements the owner-approved [Phase4B contract](PHASE4_COMPLETION_CONTRACT.md). Phase4A is merged at52c76dacc84c9770af6e42a7468b982085746ff9. Phase4B is under qualification and review; Phase4C-F remain unfinished. No public deployment is included.

## Numerical model and identity

DISCOUNT_LOG_LINEAR_ACT365F_V1 discounts the original contractual future cash flows using named immutable USD fixtures. Node offsets are exact calendar days365/730/1825/3650 from asof; t=days/365 and implicit DF(0)=1. Log-DF interpolation applies only between day0 and3650. Negative rates and DF>1 are valid.

| Fixture     | Day365 | Day730 | Day1825 | Day3650 |
| ----------- | ------ | ------ | ------- | ------- |
| BASE_UP_V1  | 0.02   | 0.025  | 0.03    | 0.035   |
| FLAT_V1     | 0.03   | 0.03   | 0.03    | 0.03    |
| NEGATIVE_V1 | -0.01  | -0.01  | -0.01   | -0.01   |

The strict Gregorian asof range is2025-01-15 through2031-01-14. The two original coupon instruments retain their existing semiannual cash amounts, dates, day-count accrual and settlement-day exclusion; zero retains its one100-per100 redemption and zero accrual. No scalar v1 or simple-yield v2 formula is substituted.

Original coupon definition versions are the existing immutable database IDs phase1-ust-1 and phase1-corp-1 from preserved migration001. Their financial source6016fb700840d081fe1fba651c918f0a7e709383 is unchanged. Zero retains SYN-ZERO-2031_V1. These existing identities appear only in the new v3 response; no legacy definition is renamed.

Snapshot SHA256 binds JSON.stringify in this property order: version1, model_version, currency, fixture_id, as_of_date, nodes. Each node contains offset_days then zero_rate fixed12 decimals; the four offsets retain their declared order. The displayed20-decimal discount_factor is derived and excluded from the identity. Canonical snapshots/nodes are deeply immutable; numerical helpers accept only snapshots created by the internal fixed-fixture factory.

Continuous spread multiplies DF by exp(-z*t), z in[-0.10,1.00]. Inversion targets exact supplied clean plus unrounded accrued, at most200 bisection iterations, per100 price residual<1e-24. Only bracket endpoint wire rounding may differ by half a displayed price quantum5e-11. Near maturity, displayed-price round trips preserve the quote and supported bracket; they do not promise recovery of more spread digits than the rounded quote contains.

Exact rational cash-flow/accrual/log-DF coefficients feed isolated80-significant-digit HALF_EVEN exponentials. The implementation avoids an exp/log round trip. Exact flat-rate/spread cancellation is recognized before exponentiation. Quoted targets and all-zero-exponent valuations retain exact rational mark proofs. Other marks use a1e-50USD numerical allowance; differing rounded interval endpoints return NUMERICAL_AMBIGUITY rather than choose a cent. This is a bounded engineering model and independent agreement, not external numerical or market-convention certification.

Prices/accrual10dp, spread12dp, markUSD2dp. A curve mark is never a posted cash amount.

## Authenticated reads and CLI

Both current trader and viewer may read:

- GET /api/fixed-income/v3/curves?fixture_id=FLAT_V1&as_of_date=2030-01-15
- GET /api/fixed-income/v3/analytics?fixture_id=FLAT_V1&as_of_date=2030-01-15&instrument_id=SYN-ZERO-2031&par_amount=1000000&z_spread=0

Analytics takes exactly one z_spread or clean_price. Financial inputs are decimal strings, at most12 fractional digits for rate/price, par1..1000000000 with at most2. Unknown, repeated, malformed or unsupported fields fail400; absent current authentication fails401. Numerical ambiguity has an explicit safe400 error envelope. Reads use existing admission and never mutate books or expand RFQ/order eligibility. No new UI is included.

Run the same model without credentials/network:

```bash
node --import tsx scripts/curve-analytics.ts <<'JSON'
{"fixture_id":"FLAT_V1","as_of_date":"2030-01-15","instrument_id":"SYN-ZERO-2031","par_amount":"999999900.31","z_spread":"0"}
JSON
```

The CLI caps stdin at16384 bytes, emits the typed result on stdout and safe JSON errors on stderr with exit1.

## Executed evidence and qualification boundary

Observed RED before implementation: missing domain modules, missing independent oracle, missing CLI, and11 HTTP404 failures out of12 discovered cases. All first-failure logs and25 generated HTTP failure evidence files remain retained.

Thirty-one new Node tests cover exact rationals, original accrual/flow semantics, canonical immutability/identity, interpolation, spreads, input/wire rejection, numerical ambiguity, global Decimal isolation and actual CLI execution. The prior full suite plus29 curve tests passed1075/1075 before CLI/original-version regression additions; full candidate qualification including both is pending.

A separately authored Python125-digit Decimal/Fraction oracle uses forward cash-flow construction, log-DF interpolation and safeguarded analytic-Newton inversion. All147 forward cases and19 exact quote targets agree: prices5e-10 per100, spread2e-11 annual decimal, DF5e-20, mark cents identical. The oracle imports no application code or generated expected results. Shared written conventions remain a modeling assumption.

| Literal case                                               | Actual result                          | Failure prevented                         |
| ---------------------------------------------------------- | -------------------------------------- | ----------------------------------------- |
| One-year zero, flat3%, par1000000                          | 97.0445533549 per100;970445.53USD mark | Wrong continuous discounting              |
| Same zero, par999999900.31                                 | 970445436.80USD                        | Rounded displayed price gives970445436.81 |
| One remaining102 flow, flat3% plus-3% spread, par1.25/1.75 | 1.28/1.78USD                           | Incorrect HALF_EVEN midpoint decisions    |
| Coupon profile at2030-01-15, flat3%, par1000000            | 100.9559112204 per100;1009559.11USD    | Changed contractual schedule or principal |

All12 new real HTTP cases pass, including current viewer/trader,401/400 envelopes, independent OpenAPI validation and unchanged original books/catalogues. Existing40 paths and64 schemas are structurally identical; only2 new paths and5 new schemas were added.

Full validate, repeat-each2, source-preservation disposition and whole-branch review are still required. The current approved preservation-v2 contract pins the exact Phase4A bytes for two API files. These new curve route/schema bytes are outside that exact exception. Do not refresh hashes, widen that exception or claim complete native qualification without an approved subsequent exact contract.

Portfolio risk, corrections/busts, settlement, FIFO P&L, migration010 and their authoritative inventory/recovery/capacity proof belong to subsequent approved slices. No remaining-scope completion is claimed here.
