import type { Decimal } from 'decimal.js';
import { curveMeasure, roundCurveMark } from '../fixed-income-v3/analytics.js';
import type { CurveInstrumentId } from '../fixed-income-v3/cash-flows.js';
import type { CurveSnapshot } from '../fixed-income-v3/curves.js';
import { Rational, decimal80 } from '../fixed-income-v3/numbers.js';

export const dollarRiskModel = 'CURVE_DOLLAR_RISK_ACT365F_V1' as const;
export const stressIds = Object.freeze([
  'PARALLEL_UP_100',
  'PARALLEL_DOWN_100',
  'STEEPENER_V1',
] as const);
export type StressId = (typeof stressIds)[number];
type Four<T> = readonly [T, T, T, T];
export interface RiskVector {
  readonly pv: Decimal;
  readonly parallel_dv01: Decimal;
  readonly key_rate_dv01: Four<Decimal>;
  readonly stress_pnl: Readonly<Record<StressId, Decimal>>;
}
export interface DollarRiskWire {
  readonly pv_usd: string;
  readonly parallel_dv01_usd: string;
  readonly key_rate_dv01_usd: Four<string>;
  readonly stress_pnl_usd: Readonly<Record<StressId, string>>;
}
const four = <T>(value: (index: number) => T): Four<T> =>
  Object.freeze([value(0), value(1), value(2), value(3)]);
const scenarioShifts: Readonly<Record<StressId, Four<number>>> = Object.freeze({
  PARALLEL_UP_100: Object.freeze([100, 100, 100, 100] as const),
  PARALLEL_DOWN_100: Object.freeze([-100, -100, -100, -100] as const),
  STEEPENER_V1: Object.freeze([-50, -25, 25, 50] as const),
});

/** Pure mathematical kernel; an owned assessment separately admits complete source inventory. */
export function instrumentDollarRisk(
  curve: CurveSnapshot,
  instrument: CurveInstrumentId,
  signedPar: Rational,
): RiskVector {
  if (
    signedPar.mul(new Rational(100n)).denominator !== 1n ||
    signedPar.toDecimal().abs().gt('8000000000')
  )
    throw new Error('Signed risk par outside the eight-root cent-par domain.');
  const price = (bumps?: readonly number[]): Decimal =>
    curveMeasure(
      curve,
      instrument,
      new Rational(0n),
      bumps?.map((bp) => new Rational(BigInt(bp))),
    )
      .dirty.mul(signedPar.toDecimal())
      .div(100);
  const pv = price();
  return Object.freeze({
    pv,
    parallel_dv01: price([-1, -1, -1, -1])
      .sub(price([1, 1, 1, 1]))
      .div(2),
    key_rate_dv01: four((index) => {
      const down = Array.from({ length: 4 }, (_, i) => (i === index ? -1 : 0));
      const up = Array.from({ length: 4 }, (_, i) => (i === index ? 1 : 0));
      return price(down).sub(price(up)).div(2);
    }),
    stress_pnl: Object.freeze({
      PARALLEL_UP_100: price(scenarioShifts.PARALLEL_UP_100).sub(pv),
      PARALLEL_DOWN_100: price(scenarioShifts.PARALLEL_DOWN_100).sub(pv),
      STEEPENER_V1: price(scenarioShifts.STEEPENER_V1).sub(pv),
    }),
  });
}

export function aggregateDollarRisk(vectors: readonly RiskVector[]): RiskVector {
  if (vectors.length > 8) throw new Error('Risk aggregate exceeds eight roots.');
  const sum = (pick: (vector: RiskVector) => Decimal): Decimal =>
    vectors.reduce((total, vector) => total.add(pick(vector)), decimal80(0));
  return Object.freeze({
    pv: sum((vector) => vector.pv),
    parallel_dv01: sum((vector) => vector.parallel_dv01),
    key_rate_dv01: four((index) => sum((vector) => vector.key_rate_dv01[index]!)),
    stress_pnl: Object.freeze({
      PARALLEL_UP_100: sum((vector) => vector.stress_pnl.PARALLEL_UP_100),
      PARALLEL_DOWN_100: sum((vector) => vector.stress_pnl.PARALLEL_DOWN_100),
      STEEPENER_V1: sum((vector) => vector.stress_pnl.STEEPENER_V1),
    }),
  });
}
const fixedRisk = (value: Decimal): string => {
  const fixed = value.toFixed(8);
  return decimal80(fixed).isZero() ? '0.00000000' : fixed;
};
export function dollarRiskWire(vector: RiskVector): DollarRiskWire {
  return Object.freeze({
    pv_usd: roundCurveMark(vector.pv, decimal80('1e-50')),
    parallel_dv01_usd: fixedRisk(vector.parallel_dv01),
    key_rate_dv01_usd: four((index) => fixedRisk(vector.key_rate_dv01[index]!)),
    stress_pnl_usd: Object.freeze({
      PARALLEL_UP_100: fixedRisk(vector.stress_pnl.PARALLEL_UP_100),
      PARALLEL_DOWN_100: fixedRisk(vector.stress_pnl.PARALLEL_DOWN_100),
      STEEPENER_V1: fixedRisk(vector.stress_pnl.STEEPENER_V1),
    }),
  });
}
