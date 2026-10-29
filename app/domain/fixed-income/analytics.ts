import { quoteCash, yieldCash } from './cash.js';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import {
  instrumentSchema,
  instruments,
  conventions,
  analyticsResponseSchema,
} from './contracts.js';
export { instruments, instrumentsResponseSchema, analyticsResponseSchema } from './contracts.js';
import { actualDays, couponDates, dayCountUS, parseDate } from './dates.js';

const D = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_EVEN });
const inputDecimal = z
  .string()
  .max(24)
  .regex(/^-?\d{1,10}(?:\.\d{1,12})?$/);
const querySchema = z
  .object({
    instrument_id: instrumentSchema.shape.id,
    settlement_date: z.string().length(10),
    par_amount: z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/),
    yield: inputDecimal.optional(),
    clean_price: inputDecimal.optional(),
  })
  .strict()
  .refine(
    (q) => (q.yield === undefined) !== (q.clean_price === undefined),
    'Supply yield or clean_price, exclusively.',
  );
export function analytics(input: unknown): z.infer<typeof analyticsResponseSchema> {
  const q = querySchema.parse(input);
  const instrument = instruments.find((i) => i.id === q.instrument_id)!;
  parseDate(q.settlement_date);
  if (q.settlement_date < instrument.dated_date || q.settlement_date >= instrument.maturity_date)
    throw new Error(
      'Settlement must be on/after dated date and strictly before maturity; maturity has no YTM.',
    );
  const par = new D(q.par_amount);
  if (par.lt(1) || par.gt('1000000000'))
    throw new Error('Par amount must be 1 through 1000000000 USD.');
  const schedule = couponDates(instrument.dated_date, instrument.maturity_date);
  const remaining = schedule.filter((d) => d > q.settlement_date);
  const previous =
    [...schedule].reverse().find((d) => d <= q.settlement_date) ?? instrument.dated_date;
  const next = remaining[0]!;
  const elapsed =
    instrument.day_count === 'ACT_ACT_ICMA'
      ? actualDays(previous, q.settlement_date)
      : dayCountUS(previous, q.settlement_date);
  const period = instrument.day_count === 'ACT_ACT_ICMA' ? actualDays(previous, next) : 180;
  const fraction = new D(elapsed).div(period);
  const coupon = new D(instrument.coupon_rate).mul(50);
  const accrued = coupon.mul(fraction),
    w = new D(1).sub(fraction);
  const pv = (y: Decimal) => {
    const base = y.div(2).add(1);
    let price = new D(0),
      derivative = new D(0),
      second = new D(0);
    let discount = new D(1).div(base.pow(w));
    remaining.forEach((_, k) => {
      const exponent = w.add(k);
      const cf = coupon.add(k === remaining.length - 1 ? 100 : 0);
      const value = cf.mul(discount);
      discount = discount.div(base);
      price = price.add(value);
      derivative = derivative.sub(value.mul(exponent).div(base.mul(2)));
      second = second.add(value.mul(exponent).mul(exponent.add(1)).div(base.pow(2).mul(4)));
    });
    return { price, derivative, second };
  };
  let y: Decimal;
  let suppliedClean: Decimal | undefined;
  if (q.yield !== undefined) {
    y = new D(q.yield);
    if (y.lt('-.10') || y.gt(1))
      throw new Error('Yield outside supported [-0.10, 1.00] annual decimal range.');
  } else {
    suppliedClean = new D(q.clean_price!);
    if (suppliedClean.lte(0) || suppliedClean.gt(10000))
      throw new Error('Clean price must be positive and at most 10000 per 100 par.');
    const target = suppliedClean.add(accrued);
    let lo = new D('-.10'),
      hi = new D(1);
    // A half output-price quantum permits exact wire round trips at bracket endpoints.
    const tolerance = new D('0.00000000005');
    if (target.gt(pv(lo).price.add(tolerance)) || target.lt(pv(hi).price.sub(tolerance)))
      throw new Error('Clean price has no yield in the supported range.');
    if (target.gte(pv(lo).price)) y = lo;
    else if (target.lte(pv(hi).price)) y = hi;
    else {
      y = lo;
      let converged = false;
      for (let i = 0; i < 180; i++) {
        y = lo.add(hi).div(2);
        const difference = pv(y).price.sub(target);
        if (difference.abs().lt('1e-32')) {
          converged = true;
          break;
        }
        if (difference.gt(0)) lo = y;
        else hi = y;
      }
      if (!converged) throw new Error('Yield solver did not converge.');
    }
  }
  const result = pv(y);
  const dirty = suppliedClean?.add(accrued) ?? result.price;
  const modified = result.derivative.neg().div(result.price);
  const bump = new D('0.0001');
  return analyticsResponseSchema.parse({
    instrument,
    settlement_date: q.settlement_date,
    par_amount: par.toFixed(2),
    yield: y.toFixed(12),
    clean_price: (suppliedClean ?? dirty.sub(accrued)).toFixed(10),
    dirty_price: dirty.toFixed(10),
    accrued_interest: accrued.toFixed(10),
    macaulay_duration: modified.mul(y.div(2).add(1)).toFixed(10),
    modified_duration: modified.toFixed(10),
    convexity: result.second.div(result.price).toFixed(10),
    dv01_usd: pv(y.sub(bump))
      .price.sub(pv(y.add(bump)).price)
      .div(2)
      .mul(par)
      .div(100)
      .toFixed(8),
    consideration_usd:
      q.clean_price !== undefined
        ? quoteCash(q.clean_price, q.par_amount, elapsed, period)
        : yieldCash(
            q.yield!,
            q.par_amount,
            remaining.length,
            elapsed,
            period,
            result.price.mul(par).toFixed(0, Decimal.ROUND_FLOOR),
          ),
    previous_coupon_date: previous,
    next_coupon_date: next,
    remaining_coupon_dates: remaining,
    conventions,
  });
}
