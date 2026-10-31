# Phase 1 financial contract

This is a fictional USD fixed-income analytics simulator. Treasury-style means a named convention profile, not an issued U.S. Treasury security or an auction calculator. No market prices, brokerage, FIX execution, portfolio positions, settlement, tax, credit/default modeling or regulated-venue claim is made by this phase.

## Instrument definitions

| ID            | Fictional issuer                   | Dated date | First coupon | Maturity   | Annual coupon | Frequency | Accrual            |
| ------------- | ---------------------------------- | ---------- | ------------ | ---------- | ------------- | --------- | ------------------ |
| SYN-UST-2031  | Fictional Treasury-style reference | 2025-01-15 | 2025-07-15   | 2031-01-15 | 0.04 (4%)     | 2         | Actual/Actual ICMA |
| SYN-CORP-2031 | Fictional Meridian Industries      | 2025-01-15 | 2025-07-15   | 2031-01-15 | 0.04 (4%)     | 2         | US/NASD 30/360     |

Both intentionally share dates and coupons so the convention difference is observable without other changing inputs. Each returns principal 100 per 100 par at maturity. There are 12 coupons: July 15, 2025; January/July 15, 2026–2030; January 15, 2031. Payments and accrual dates are unadjusted contractual dates, with no holiday/calendar roll, payment delay or ex-dividend period. The schedule generator anchors backward to maturity, preserves end-of-month where maturity is EOM and rejects irregular first periods. Stubs, callable, floating, inflation-linked and amortizing instruments are unsupported.

## Dates and day counts

Dates are strict Gregorian YYYY-MM-DD in 1900–2100, not timestamps. Calculation uses UTC calendar days. Settlement must be on/after dated date and strictly before maturity. A settlement-day coupon is excluded from remaining cash flows and accrued interest resets to zero; redemption/maturity and post-maturity analytics are rejected because a remaining-cash-flow YTM is undefined.

For Actual/Actual ICMA regular semiannual periods, accrual fraction a = actual elapsed days / actual days in the coupon period. Accrued interest per 100 = 2a. For US 30/360, a = adjusted elapsed days / 180. Adjust start day31 or February EOM to30; adjust end February EOM to30 when start was also February EOM; adjust end31 to30 when adjusted start day is30. Day count = 360(Y2-Y1)+30(M2-M1)+D2-D1. This is US/NASD, not 30E/360.

At 2028-02-29, previous coupon 2028-01-15 and next 2028-07-15: Actual elapsed45/182 gives AI0.494505494505…; US adjusted44/180 gives AI0.488888888888…. At 2026-10-15, elapsed92/184 gives AI1.00. A clean99.875 gives dirty100.875 and consideration1008750.00 on par1000000.

## Pricing, inverse yield and risk

Rates are annual decimal fractions, with semiannual compounding (0.04 means4%). Let b=1+y/2, w=1-a, and k=0,…,N-1 for future coupons. Dirty price P = sum(CF_k / b^(k+w)); CF is2, plus100 redemption for the final flow. Clean=P-AI. This fractional-period compound model is explicitly selected; it is not a claim to reproduce all Treasury auction/odd-period methods. See Treasury's [published calculation procedure](https://www.treasurydirect.gov/instit/annceresult/press/preanre/2004/ofcalc6decnote.pdf) for a different procedure that must not be silently substituted.

Yield inputs are bounded to [-0.10,1.00]. Clean inputs must be positive and <=10000 and imply a yield in that bracket. TypeScript uses bounded bisection, price residual <1e-32, at most180 iterations; failure is explicit. A half displayed-price quantum (5e-11) permits inverse round trips at bracket endpoints after wire rounding, clamping only that negligible difference.

Modified duration=-P'/P, Macaulay=modified*(1+y/2), convexity=P''/P. Derivatives are analytic derivatives of the selected dirty-price model, not derivatives of rounded output. Duration units years, convexity years squared. Dollar DV01=[P(y-0.0001)-P(y+0.0001)]/2 * par/100, positive for these long positions. Risk shocks may extend one bp beyond the accepted input-yield bracket; the discount base remains positive. Accrued interest is held fixed for yield risk.

## Precision, scales and ranges

Financial inputs are decimal strings, never JavaScript binary-number financial values. Decimal.js uses an isolated50-significant-digit context and ROUND_HALF_EVEN. Calendar counts/indexes are integers. No intermediate currency/display rounding occurs. Cash rounding uses exact rational inputs and integer quotient/remainder comparisons; yield-mode fractional powers are compared to cent midpoints after raising positive rational quantities to the exact accrual denominator. The 50-digit PV supplies only a floor estimate, corrected by exact comparisons, so numerical approximation cannot decide an exact half-cent tie. Prices and AI have10 decimal places; yield12; duration/convexity10; dollar DV018; par and consideration2. Coupon and principal units are per100 par; par is USD face amount. Par range1–1000000000 with <=2 fractional digits. Rate/price strings have <=12 fractional digits and <=24 total characters; exponent notation, NaN and Infinity are rejected.

For supplied clean price, dirty=that exact quote+unrounded AI; risk uses its solved yield. For supplied yield, cash uses the unrounded PV. Consideration=dirty*par/100, rounded once to cents; multiplying a displayed10-decimal price can differ by a penny at large par. Displayed yield is not the full-precision inverse used internally. Consideration is a synthetic valuation amount, not a posted settlement obligation.

## HTTP and UI

Authenticated GET /api/fixed-income/v1/instruments lists the two instruments. Authenticated GET /api/fixed-income/v1/analytics requires instrument_id, settlement_date, par_amount and exactly one of yield or clean_price. No other/repeated query fields are allowed. Both roles may read. These routes consume existing hosted global admission; they do not create orders, extend/revoke sessions or consume an order-mutation entitlement. Existing error envelope is retained. Output includes the instrument, dates, remaining coupons, fixed-scale decimal strings and conventions. OpenAPI is independently authored rather than generated from runtime schemas.

Analytics is a collapsible workspace panel, preserving all four existing tab/keyboard behaviors. Only the current token/request epoch may populate results; logout clears the panel and late old-session responses are discarded. Inputs are never parsed through Number for financial calculations. The legacy equity lab remains synthetic and unchanged.

## Verification and limitations

The independent Python oracle was authored from the written contract without inspecting/importing TypeScript. It uses72-digit Decimal ln/exp pricing, safeguarded Newton/secant inversion and convergence-checked five-point finite differences with Richardson extrapolation for Greeks. Eight frozen goldens use independently calculated rational prices and analytic derivatives; they are not generated from application output. See verification/python/README.md for reproduction and tolerances. The HTTP gate owns one temporary loopback server and an ephemeral session; external origins and redirects are refused.

A shared written convention is still a shared modeling assumption. Agreement does not prove universal market convention coverage or external certification. No QuantLib interoperability claim is made. Precision is finite, fractional powers are numerical approximations, cash uses the declared rounding rule, and the supported instruments/ranges are deliberately bounded. Subsequent trading, persistence, FIX, curves and settlement phases remain unimplemented.
