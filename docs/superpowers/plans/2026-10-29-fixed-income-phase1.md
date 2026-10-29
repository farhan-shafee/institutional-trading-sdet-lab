# Fixed-Income Analytics Phase 1 Implementation Plan

Goal: additive synthetic bond analytics with independent Python verification; no trading engine, persistence, deployment or infrastructure changes.

Architecture: keep the existing Node/TypeScript application, session ownership, hosted admission controls and equity API unchanged. A focused fixed-income domain and router supply an authenticated, stateless GET API and an additional workstation tab. Python standard-library Decimal supplies an independently authored numerical oracle against actual HTTP responses.

## Binding conventions and interfaces

- Two fictional USD 4% semiannual bullet instruments, dated 2025-01-15, maturity 2031-01-15; coupon dates January/July 15. IDs SYN-UST-2031 (ACT_ACT_ICMA) and SYN-CORP-2031 (THIRTY_360_US). Regular coupons only; principal 100 per 100 par.
- Calendar dates are strict YYYY-MM-DD Gregorian dates. Settlement must satisfy dated_date <= settlement < maturity. Settlement-day coupon excluded; accrual resets to zero. Unadjusted contractual coupon dates; no holiday/payment adjustment or ex-dividend period. Synthetic settlement consideration is valuation, not settlement processing.
- Decimal strings only. Rates are annual decimal fractions. Precision 50 significant digits, ROUND_HALF_EVEN. No intermediate currency rounding. Price/AI outputs 10 decimals, yield 12, risk measures 10, dollar DV01 8, consideration 2. Supported yield [-0.10, 1.00], clean price (0,10000], par [1,1000000000] with <=2 decimals. Inputs bounded in length/scale; output must remain finite. One basis point = 0.0001.
- Discount cash flow k by (1+y/2)^(k-1+w), where w=1-accrual_fraction. ICMA elapsed/actual coupon-period days; US 30/360 handles February EOM and 31st-day rules. Coupon amount = 100*rate/2. Dirty price = PV; clean=dirty-AI. YTM uses bisection on the supported interval with explicit price-out-of-range rejection. Modified duration/convexity are analytic first/second derivatives of dirty price; Macaulay=modified*(1+y/2); DV01=(P(y-0.0001)-P(y+0.0001))/2 * par/100. Boundary risk bump can extend by one bp beyond accepted input interval, still with a positive compounding base.
- GET /api/fixed-income/v1/instruments -> {instruments: Instrument[]}.
- GET /api/fixed-income/v1/analytics?instrument_id=...&settlement_date=...&par_amount=...&yield=... OR clean_price=... -> {instrument, settlement_date, par_amount, yield, clean_price, dirty_price, accrued_interest, macaulay_duration, modified_duration, convexity, dv01_usd, consideration_usd, previous_coupon_date, next_coupon_date, remaining_coupon_dates, conventions}. Both roles permitted; authenticated; unknown/repeated fields rejected; no mutation or session extension.
- UI retains existing tabs/keyboard order and adds a separate collapsible Analytics panel; shows explicit units/conventions, errors and clears/rejects stale prior-session responses.

## Tasks

1. Domain: failing unit cases, decimal dependency, dates/schedule/day counts/analytics, literal reference checks and malformed boundary checks.
2. API/contract: failing HTTP cases, bounded focused router, strict response schemas, independent OpenAPI, authentication/viewer/book preservation.
3. Python oracle: separately authored implementation from this convention contract only; frozen synthetic golden cases plus HTTP comparisons, independent solver/derivatives. No TypeScript imports or subprocess calculations. Standard library only.
4. Browser: failing journeys, focused view, semantic controls and stale-response ownership tests; preserve all existing tests.
5. Gates/report: CI Python 3.12 step, full existing validate and repeated suite, independent final reviewer, material fixes, branch-only push and open unmerged PR. Record actual commands/counts/failures and exact source SHAs.

## Review focus

Date parsing including year/leap boundaries; 30/360 February and EOM adjustments; output rounding versus inverse pricing; negative yields and supported-range edges; malformed HTTP200 response and delayed response after logout/relogin.

## Decisions and progress

- User approved implementation/testing/PR only. No production deployment, merge, database or other repository changes.
- Fresh dedicated clone on feature/fixed-income-analytics-phase1 isolates all edits from main.

- Ruling: preserve the existing four-tab End/arrow contract using a collapsible workspace analytics panel; no existing UI test expectations are weakened.
- Baseline: full npm run validate passed on isolated Windows worktree at3fd9b0a (54 units,211 Playwright). Cloud IPC and browser archive failures were environmental; direct Node-loader execution and the existing workstation browsers provide verification without changing repository commands.
- API strict-field regression exposed **proto** being ignored by a plain object; RED400-versus200 recorded, then fixed with a null-prototype query accumulator.

- Final review found a material shared cent-rounding blind spot: repeating AI before multiplying par made exact46.005 round46.01. Literal RED regression added. Exact rational/algebraic midpoint comparisons now decide cash, with independent Python Fraction verification.
- Production-only smoke initially rejected the newly approved decimal.js runtime dependency under its old zod-only allowlist. Updated the exact allowlist to decimal.js+zod, retaining exclusion of development tooling and adding a native financial tie check.
- Native workstation Git push was denied for a different configured account; authenticated GitHub connector publication will create only the feature ref with the verified source tree.

- Full cross-browser RED: all three engines caught disclosure summary interrupting nav-to-active-panel Tab order. Moved disclosure after the four existing tabpanels, preserving unchanged keyboard tests and all controls.
