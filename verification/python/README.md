# Independent fixed-income verification

The Python 3.12-compatible verifier has no third-party dependencies. Its only
financial specification is the written Phase 1 convention contract. It imports
no application modules, executes no TypeScript calculation, and uses fictional
instruments only.

```sh
python3 -m unittest discover -s verification/python -p 'test_*.py' -v
python3 verification/python/verify.py --base-url http://127.0.0.1:PORT
python3 verification/python/verify.py --base-url http://127.0.0.1:PORT --summary verification/python/verification-summary.json
```

The caller starts a disposable local server first. The verifier refuses remote
origins, disables ambient proxies and redirects, creates an ephemeral test
session, retains its token in memory, and deletes the session in `finally`.
It prints JSON to stdout and returns nonzero on any failure. `--summary` also
writes the same JSON to the named file. No live market data is used.

The independent methods are:

- 72 significant digit Decimal arithmetic, with ln/exp fractional discounting.
- Safeguarded Newton/secant inverse pricing against the exact market quote.
- Five-point finite-difference Greeks, Richardson extrapolation, and a numerical
  convergence check, independent of the application's analytic derivatives.
- Frozen price/risk goldens calculated with rational cash flows and analytic
  derivatives; Decimal 85-digit repricing supplies the one-basis-point bump.
- Exact Fraction accrual and quote cash rounding. Yield-priced consideration
  uses a rational payment sum and exact integer-power comparisons to decide
  half-cent boundaries, including fractional compounding powers. Finite Decimal
  precision alone cannot correctly decide a true half-cent tie.

The HTTP suite includes 54 financial cases: 28 yield cases, 18 quote inversions
(including rounded endpoint quotes), and eight frozen goldens. Both day-count
instruments, leap day, coupon resets, negative/zero/high yields, last-day cash
flows, par limits and exact-input consideration are covered. Six literal cash
regressions exercise even/odd half-cent ties for quotes, coupon-date yields, and
fractional-period yield powers. Additional HTTP
checks cover authentication, instrument metadata, output precision, malformed
inputs, out-of-bracket quotes, and session cleanup. Boundary quotes may be half
a ten-decimal output quantum outside the exact yield bracket and clamp to that
endpoint; consideration always uses the supplied quote and unrounded accrual.
