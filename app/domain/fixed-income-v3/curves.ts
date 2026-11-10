import { createHash } from 'node:crypto';
import type { Decimal } from 'decimal.js';
import { curveDate } from './cash-flows.js';
import { Rational } from './numbers.js';

export const curveFixtureIds = Object.freeze(['BASE_UP_V1', 'FLAT_V1', 'NEGATIVE_V1'] as const);
export type CurveFixtureId = (typeof curveFixtureIds)[number];
const offsets = Object.freeze([365, 730, 1825, 3650]);
const fixtures = Object.freeze({
  BASE_UP_V1: Object.freeze(['0.02', '0.025', '0.03', '0.035']),
  FLAT_V1: Object.freeze(['0.03', '0.03', '0.03', '0.03']),
  NEGATIVE_V1: Object.freeze(['-0.01', '-0.01', '-0.01', '-0.01']),
});
export interface CurveNode {
  readonly offset_days: number;
  readonly zero_rate: string;
  readonly discount_factor: string;
}
export interface CurveSnapshot {
  readonly version: 1;
  readonly model_version: 'DISCOUNT_LOG_LINEAR_ACT365F_V1';
  readonly currency: 'USD';
  readonly fixture_id: CurveFixtureId;
  readonly as_of_date: string;
  readonly nodes: readonly CurveNode[];
  readonly snapshot_id: string;
}
const trustedSnapshots = new WeakSet<CurveSnapshot>();

/** Stateless named fixture; canonical identity binds rates, never rounded display discount factors. */
export function curveSnapshot(fixtureId: CurveFixtureId, asOf: string): CurveSnapshot {
  curveDate(asOf);
  if (!Object.hasOwn(fixtures, fixtureId)) throw new Error('Unsupported synthetic curve fixture.');
  const canonical = {
    version: 1 as const,
    model_version: 'DISCOUNT_LOG_LINEAR_ACT365F_V1' as const,
    currency: 'USD' as const,
    fixture_id: fixtureId,
    as_of_date: asOf,
    nodes: offsets.map((offset, index) => ({
      offset_days: offset,
      zero_rate: Rational.decimal(fixtures[fixtureId][index]!).fixed(12),
    })),
  };
  const snapshot: CurveSnapshot = Object.freeze({
    ...canonical,
    nodes: Object.freeze(
      canonical.nodes.map((node) =>
        Object.freeze({
          ...node,
          discount_factor: Rational.decimal(node.zero_rate)
            .mul(new Rational(BigInt(-node.offset_days), 365n))
            .toDecimal()
            .exp()
            .toFixed(20),
        }),
      ),
    ),
    snapshot_id: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
  });
  trustedSnapshots.add(snapshot);
  return snapshot;
}

function validNodeShocks(value: unknown): value is readonly Rational[] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((shock: unknown) => shock instanceof Rational && shock.toDecimal().abs().lte(100))
  );
}

/** Exact log-DF coefficient, including continuous spread and finite internal risk shocks. */
export function curveExponent(
  snapshot: CurveSnapshot,
  days: number,
  spread: Rational,
  shocksBp?: readonly Rational[],
): Rational {
  if (!trustedSnapshots.has(snapshot)) throw new Error('Untrusted curve snapshot.');
  if (!Number.isInteger(days) || days < 0 || days > 3650)
    throw new Error('Curve extrapolation or fractional day is unsupported.');
  if (!(spread instanceof Rational) || spread.toDecimal().lt('-0.10') || spread.toDecimal().gt(1))
    throw new Error('Spread outside supported range.');
  if (shocksBp !== undefined && !validNodeShocks(shocksBp))
    throw new Error('Unsupported internal node shocks.');
  if (days === 0) return new Rational(0n);
  const right = snapshot.nodes.findIndex((node) => node.offset_days >= days);
  const end = snapshot.nodes[right]!;
  const start = right === 0 ? undefined : snapshot.nodes[right - 1]!;
  const startDays = start?.offset_days ?? 0;
  const integrated = (index: number): Rational => {
    const node = snapshot.nodes[index]!;
    const rate = Rational.decimal(node.zero_rate).add(
      (shocksBp?.[index] ?? new Rational(0n)).div(new Rational(10000n)),
    );
    return rate.mul(new Rational(BigInt(node.offset_days)));
  };
  const leftRateDays = right === 0 ? new Rational(0n) : integrated(right - 1);
  const base = leftRateDays.add(
    integrated(right)
      .sub(leftRateDays)
      .mul(new Rational(BigInt(days - startDays), BigInt(end.offset_days - startDays))),
  );
  return base.add(spread.mul(new Rational(BigInt(days)))).div(new Rational(-365n));
}

export function discountFactor(
  snapshot: CurveSnapshot,
  days: number,
  spread = '0',
  shocksBp?: readonly Rational[],
): Decimal {
  return curveExponent(snapshot, days, Rational.decimal(spread), shocksBp).toDecimal().exp();
}
