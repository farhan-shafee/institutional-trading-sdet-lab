import { instruments } from '../fixed-income/contracts.js';
import { actualDays, couponDates, dayCountUS, parseDate } from '../fixed-income/dates.js';
import { zeroInstruments } from '../fixed-income-v2/zero.js';
import { Rational } from './numbers.js';

export const curveInstrumentIds = Object.freeze([
  'SYN-UST-2031',
  'SYN-CORP-2031',
  'SYN-ZERO-2031',
] as const);
export type CurveInstrumentId = (typeof curveInstrumentIds)[number];
export const curveDefinitionVersions: Readonly<Record<CurveInstrumentId, string>> = Object.freeze({
  'SYN-UST-2031': 'phase1-ust-1',
  'SYN-CORP-2031': 'phase1-corp-1',
  'SYN-ZERO-2031': zeroInstruments[0]!.definition_version,
});
export interface CurveCashFlow {
  readonly payment_date: string;
  readonly days: number;
  readonly amount_per_100: Rational;
}
export interface CurveCashFlows {
  readonly instrument_id: CurveInstrumentId;
  readonly definition_version: string;
  readonly accrued: Rational;
  readonly remaining: readonly CurveCashFlow[];
}

export function curveDate(asOf: string): void {
  parseDate(asOf);
  if (asOf < '2025-01-15' || asOf > '2031-01-14')
    throw new Error('Curve date outside supported pre-maturity window.');
}

/** Original contractual schedules and exact accrual; no scalar-yield calculation or display reuse. */
export function curveCashFlows(instrumentId: CurveInstrumentId, asOf: string): CurveCashFlows {
  curveDate(asOf);
  if (instrumentId === 'SYN-ZERO-2031') {
    const zero = zeroInstruments[0]!;
    return Object.freeze({
      instrument_id: instrumentId,
      definition_version: curveDefinitionVersions[instrumentId],
      accrued: new Rational(0n),
      remaining: Object.freeze([
        Object.freeze({
          payment_date: zero.maturity_date,
          days: actualDays(asOf, zero.maturity_date),
          amount_per_100: new Rational(100n),
        }),
      ]),
    });
  }
  const instrument = instruments.find((i) => i.id === instrumentId);
  if (!instrument) throw new Error('Unsupported curve instrument.');
  const schedule = couponDates(instrument.dated_date, instrument.maturity_date);
  const remaining = schedule.filter((date) => date > asOf);
  const previous = [...schedule].reverse().find((date) => date <= asOf) ?? instrument.dated_date;
  const next = remaining[0]!;
  const elapsed =
    instrument.day_count === 'ACT_ACT_ICMA'
      ? actualDays(previous, asOf)
      : dayCountUS(previous, asOf);
  const period = instrument.day_count === 'ACT_ACT_ICMA' ? actualDays(previous, next) : 180;
  const coupon = Rational.decimal(instrument.coupon_rate).mul(new Rational(50n));
  return Object.freeze({
    instrument_id: instrumentId,
    definition_version: curveDefinitionVersions[instrumentId],
    accrued: coupon.mul(new Rational(BigInt(elapsed), BigInt(period))),
    remaining: Object.freeze(
      remaining.map((date, index) =>
        Object.freeze({
          payment_date: date,
          days: actualDays(asOf, date),
          amount_per_100: coupon.add(new Rational(index === remaining.length - 1 ? 100n : 0n)),
        }),
      ),
    ),
  });
}
