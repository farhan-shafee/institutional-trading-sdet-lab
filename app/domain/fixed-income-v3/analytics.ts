import type { Decimal } from 'decimal.js';
import { curveCashFlows, type CurveCashFlows, type CurveInstrumentId } from './cash-flows.js';
import { curveExponent, curveSnapshot, type CurveSnapshot } from './curves.js';
import { Rational, decimal80 } from './numbers.js';
import {
  curveAnalyticsSchema,
  curveConventions,
  curveQuerySchema,
  type CurveAnalytics,
} from './contracts.js';

export class NumericalAmbiguityError extends Error {
  constructor() {
    super('Curve mark falls on an unresolved numerical rounding boundary.');
    this.name = 'NumericalAmbiguityError';
  }
}
export interface CurveMeasure {
  readonly dirty: Decimal;
  readonly clean: Decimal;
  readonly accrued: Rational;
  readonly flows: CurveCashFlows;
  readonly exact_dirty?: Rational;
}
function measureFlows(
  snapshot: CurveSnapshot,
  flows: CurveCashFlows,
  spread: Rational,
  shocksBp?: readonly Rational[],
): CurveMeasure {
  let dirty = decimal80(0),
    exactDirty = new Rational(0n),
    allExact = true;
  for (const flow of flows.remaining) {
    const exponent = curveExponent(snapshot, flow.days, spread, shocksBp);
    dirty = dirty.add(flow.amount_per_100.toDecimal().mul(exponent.toDecimal().exp()));
    allExact = allExact && exponent.isZero();
    exactDirty = exactDirty.add(flow.amount_per_100);
  }
  return {
    dirty,
    clean: dirty.sub(flows.accrued.toDecimal()),
    accrued: flows.accrued,
    flows,
    ...(allExact ? { exact_dirty: exactDirty } : {}),
  };
}
export function curveMeasure(
  snapshot: CurveSnapshot,
  instrumentId: CurveInstrumentId,
  spread: Rational,
  shocksBp?: readonly Rational[],
): CurveMeasure {
  return measureFlows(
    snapshot,
    curveCashFlows(instrumentId, snapshot.as_of_date),
    spread,
    shocksBp,
  );
}
const spreadRatio = (spread: Decimal): Rational => Rational.decimal(spread.toFixed(80));

/** Monotone bounded inversion. Only displayed-price bracket endpoints admit a half-quantum allowance. */
export function solveSpread(
  snapshot: CurveSnapshot,
  flows: CurveCashFlows,
  exactTarget: Rational,
): Decimal {
  const target = exactTarget.toDecimal(),
    allowance = decimal80('0.00000000005');
  let low = decimal80('-0.10'),
    high = decimal80(1);
  const pv = (spread: Decimal): Decimal => measureFlows(snapshot, flows, spreadRatio(spread)).dirty;
  const upperPrice = pv(low),
    lowerPrice = pv(high);
  if (target.gt(upperPrice.add(allowance)) || target.lt(lowerPrice.sub(allowance)))
    throw new Error('Clean price has no spread in the supported bracket.');
  if (target.gte(upperPrice)) return low;
  if (target.lte(lowerPrice)) return high;
  for (let iteration = 0; iteration < 200; iteration++) {
    const spread = low.add(high).div(2);
    const difference = pv(spread).sub(target);
    if (difference.abs().lt('1e-24')) return spread;
    if (difference.gt(0)) low = spread;
    else high = spread;
  }
  throw new Error('Continuous spread solver did not converge.');
}

/** Numerically uncertain marks are unavailable; an exact rational proof resolves real half-cent ties. */
export function roundCurveMark(
  value: Decimal,
  numericalAllowance: Decimal,
  exactValue?: Rational,
): string {
  const mark = decimal80(value),
    allowance = decimal80(numericalAllowance);
  if (!mark.isFinite() || !allowance.isFinite() || allowance.lte(0))
    throw new NumericalAmbiguityError();
  if (exactValue !== undefined) {
    if (mark.sub(exactValue.toDecimal()).abs().gt(allowance)) throw new NumericalAmbiguityError();
    return exactValue.fixed(2);
  }
  const low = mark.sub(allowance).toFixed(2),
    high = mark.add(allowance).toFixed(2);
  if (low !== high) throw new NumericalAmbiguityError();
  return decimal80(low).isZero() ? '0.00' : low;
}

export function curveAnalytics(input: unknown): CurveAnalytics {
  const q = curveQuerySchema.parse(input);
  const snapshot = curveSnapshot(q.fixture_id, q.as_of_date);
  const flows = curveCashFlows(q.instrument_id, q.as_of_date);
  const par = Rational.decimal(q.par_amount);
  if (par.toDecimal().lt(1) || par.toDecimal().gt('1000000000'))
    throw new Error('Par outside supported range.');
  let spread: Rational;
  let quotedDirty: Rational | undefined;
  if (q.z_spread !== undefined) spread = Rational.decimal(q.z_spread);
  else {
    const clean = Rational.decimal(q.clean_price!);
    if (clean.toDecimal().lte(0) || clean.toDecimal().gt(10000))
      throw new Error('Clean price outside supported range.');
    quotedDirty = clean.add(flows.accrued);
    spread = spreadRatio(solveSpread(snapshot, flows, quotedDirty));
  }
  const measure = measureFlows(snapshot, flows, spread);
  const dirty = quotedDirty?.toDecimal() ?? measure.dirty;
  const exactDirty = quotedDirty ?? measure.exact_dirty;
  const factor = par.div(new Rational(100n));
  const mark = dirty.mul(factor.toDecimal());
  return curveAnalyticsSchema.parse({
    model_version: snapshot.model_version,
    instrument_id: q.instrument_id,
    definition_version: flows.definition_version,
    curve: snapshot,
    as_of_date: q.as_of_date,
    par_amount: par.fixed(2),
    z_spread: spread.fixed(12),
    clean_price: (q.clean_price === undefined
      ? measure.clean
      : Rational.decimal(q.clean_price).toDecimal()
    ).toFixed(10),
    dirty_price: dirty.toFixed(10),
    accrued_interest: flows.accrued.fixed(10),
    mark_value_usd: roundCurveMark(mark, decimal80('1e-50'), exactDirty?.mul(factor)),
    remaining_cash_flows: flows.remaining.map((flow) => ({
      payment_date: flow.payment_date,
      days: flow.days,
      amount_per_100: flow.amount_per_100.fixed(10),
      discount_factor: curveExponent(snapshot, flow.days, spread).toDecimal().exp().toFixed(20),
    })),
    conventions: curveConventions,
  });
}
