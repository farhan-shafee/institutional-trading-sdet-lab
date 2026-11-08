import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { actualDays, parseDate } from '../fixed-income/dates.js';

const D = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_EVEN });
const instrument = Object.freeze({
  id: 'SYN-ZERO-2031' as const,
  definition_version: 'SYN-ZERO-2031_V1' as const,
  issuer: 'Fictional zero-coupon reference' as const,
  structure: 'ZERO_COUPON' as const,
  currency: 'USD' as const,
  dated_date: '2025-01-15' as const,
  maturity_date: '2031-01-15' as const,
  coupon_rate: '0' as const,
  fictional: true as const,
});
export const zeroInstruments = Object.freeze([instrument]);
export const zeroInstrumentSchema = z
  .object({
    id: z.literal(instrument.id),
    definition_version: z.literal(instrument.definition_version),
    issuer: z.literal(instrument.issuer),
    structure: z.literal(instrument.structure),
    currency: z.literal('USD'),
    dated_date: z.literal(instrument.dated_date),
    maturity_date: z.literal(instrument.maturity_date),
    coupon_rate: z.literal('0'),
    fictional: z.literal(true),
  })
  .strict();
const decimalInput = z
  .string()
  .max(24)
  .regex(/^-?\d{1,10}(?:\.\d{1,12})?$/);
const inputSchema = z
  .object({
    instrument_id: z.literal(instrument.id),
    settlement_date: z.string().length(10),
    par_amount: z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/),
    yield: decimalInput.optional(),
    clean_price: decimalInput.optional(),
  })
  .strict()
  .refine((q) => (q.yield === undefined) !== (q.clean_price === undefined));

const flowSchema = z
  .object({
    payment_date: z.literal(instrument.maturity_date),
    coupon_per_100: z.literal('0.0000000000'),
    principal_per_100: z.literal('100.0000000000'),
  })
  .strict();
const fixed = (places: number) => z.string().regex(new RegExp(`^-?\\d+\\.\\d{${places}}$`));
export const zeroAnalyticsSchema = z
  .object({
    instrument: zeroInstrumentSchema,
    model_version: z.literal('ZERO_SIMPLE_ACT365F_V1'),
    settlement_date: z.string().date(),
    par_amount: fixed(2),
    yield: fixed(12),
    clean_price: fixed(10),
    dirty_price: fixed(10),
    accrued_interest: z.literal('0.0000000000'),
    consideration_usd: fixed(2),
    days_to_maturity: z.number().int().min(1),
    time_to_maturity_years: fixed(12),
    remaining_cash_flows: z.array(flowSchema).length(1),
    conventions: z
      .object({
        day_count: z.literal('ACT_365F'),
        yield_compounding: z.literal('SIMPLE'),
        price_unit: z.literal('per 100 par'),
        rate_unit: z.literal('annual decimal fraction'),
        rounding: z.literal('ROUND_HALF_EVEN'),
        precision_digits: z.literal(50),
        calendar: z.literal('unadjusted contractual dates'),
      })
      .strict(),
  })
  .strict();
export const zeroInstrumentsSchema = z
  .object({ instruments: z.array(zeroInstrumentSchema).length(1) })
  .strict();
export type ZeroAnalytics = z.infer<typeof zeroAnalyticsSchema>;

function days(settlement: string): number {
  parseDate(settlement);
  if (settlement < instrument.dated_date || settlement >= instrument.maturity_date)
    throw new Error('Settlement must be on/after dated date and before maturity.');
  return actualDays(settlement, instrument.maturity_date);
}
export function zeroCashFlows(settlement: string) {
  days(settlement);
  return Object.freeze([
    Object.freeze({
      payment_date: instrument.maturity_date,
      coupon_per_100: '0.0000000000' as const,
      principal_per_100: '100.0000000000' as const,
    }),
  ]);
}
type Ratio = readonly [bigint, bigint];
function ratio(text: string): Ratio {
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  return [BigInt(whole + fraction) * (negative ? -1n : 1n), 10n ** BigInt(fraction.length)];
}
function cash(
  par: string,
  quote: string | undefined,
  yieldText: string | undefined,
  count: number,
): string {
  const [pn, pd] = ratio(par);
  let numerator: bigint, denominator: bigint;
  if (quote !== undefined) {
    const [qn, qd] = ratio(quote);
    // Quote per100 * par/100 USD *100 cents.
    numerator = qn * pn;
    denominator = qd * pd;
  } else {
    const [yn, yd] = ratio(yieldText!);
    // Price per100 = 100*365*yd/(365*yd + yn*days).
    numerator = 100n * 365n * yd * pn;
    denominator = (365n * yd + yn * BigInt(count)) * pd;
  }
  if (denominator <= 0n || numerator <= 0n) throw new Error('Nonpositive cash domain.');
  let cents = numerator / denominator;
  const twice = 2n * (numerator % denominator);
  if (twice > denominator || (twice === denominator && cents % 2n !== 0n)) cents++;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}
export function zeroAnalytics(input: unknown): ZeroAnalytics {
  const q = inputSchema.parse(input);
  const count = days(q.settlement_date);
  const t = new D(count).div(365);
  const par = new D(q.par_amount);
  if (par.lt(1) || par.gt('1000000000')) throw new Error('Par outside supported range.');
  const pv = (y: Decimal) => {
    const denominator = new D(1).add(y.mul(t));
    if (denominator.lte(0)) throw new Error('Discount denominator must be positive.');
    return new D(100).div(denominator);
  };
  const lo = new D('-.10'),
    hi = new D(1);
  let y: Decimal, price: Decimal;
  if (q.yield !== undefined) {
    y = new D(q.yield);
    if (y.lt(lo) || y.gt(hi)) throw new Error('Yield outside supported range.');
    price = pv(y);
  } else {
    price = new D(q.clean_price!);
    if (price.lte(0) || price.gt(10000)) throw new Error('Price outside supported range.');
    const tolerance = new D('0.00000000005');
    const upper = pv(lo),
      lower = pv(hi);
    if (price.gt(upper.add(tolerance)) || price.lt(lower.sub(tolerance)))
      throw new Error('Price implies unsupported yield.');
    y = price.gte(upper) ? lo : price.lte(lower) ? hi : new D(100).div(price).sub(1).div(t);
  }
  const result = zeroAnalyticsSchema.parse({
    instrument,
    model_version: 'ZERO_SIMPLE_ACT365F_V1',
    settlement_date: q.settlement_date,
    par_amount: par.toFixed(2),
    yield: y.toFixed(12),
    clean_price: price.toFixed(10),
    dirty_price: price.toFixed(10),
    accrued_interest: '0.0000000000',
    consideration_usd: cash(q.par_amount, q.clean_price, q.yield, count),
    days_to_maturity: count,
    time_to_maturity_years: t.toFixed(12),
    remaining_cash_flows: zeroCashFlows(q.settlement_date),
    conventions: {
      day_count: 'ACT_365F',
      yield_compounding: 'SIMPLE',
      price_unit: 'per 100 par',
      rate_unit: 'annual decimal fraction',
      rounding: 'ROUND_HALF_EVEN',
      precision_digits: 50,
      calendar: 'unadjusted contractual dates',
    },
  });
  // Zod clones parsed objects; return the immutable canonical definition.
  result.instrument = instrument;
  return result;
}
