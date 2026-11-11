/** Browser-safe wire constants. Original financial kernels remain byte-identical. */
export const assessmentModel = 'OWNED_PORTFOLIO_ASSESSMENT_V1' as const;
export const dollarRiskModel = 'CURVE_DOLLAR_RISK_ACT365F_V1' as const;
export const fifoModel = 'FIFO_DIRTY_USD_V1' as const;
export const assessmentReasons = [
  'POSTTRADE_NOT_INITIALIZED',
  'SOURCE_INCOMPLETE',
  'ROOT_LIMIT_EXCEEDED',
  'UNREGISTERED_EXECUTION',
  'EXECUTION_OUTSIDE_ECONOMIC_WINDOW',
  'SOURCE_CUTOFF_INCOHERENT',
  'UNSUPPORTED_DEFINITION',
  'VALUATION_OUTSIDE_ECONOMIC_WINDOW',
  'VALUATION_BEFORE_VALUE_DATE',
  'SOURCE_ACCOUNTING_MISMATCH',
  'NUMERICAL_AMBIGUITY',
] as const;
