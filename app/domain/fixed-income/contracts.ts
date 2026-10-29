import { z } from 'zod';
export const instrumentSchema = z
  .object({
    id: z.enum(['SYN-UST-2031', 'SYN-CORP-2031']),
    issuer: z.string().min(1),
    currency: z.literal('USD'),
    coupon_rate: z.literal('0.04'),
    dated_date: z.literal('2025-01-15'),
    maturity_date: z.literal('2031-01-15'),
    frequency: z.literal(2),
    day_count: z.enum(['ACT_ACT_ICMA', 'THIRTY_360_US']),
    fictional: z.literal(true),
  })
  .strict();
export const instruments = Object.freeze([
  Object.freeze(
    instrumentSchema.parse({
      id: 'SYN-UST-2031',
      issuer: 'Fictional Treasury-style reference',
      currency: 'USD',
      coupon_rate: '0.04',
      dated_date: '2025-01-15',
      maturity_date: '2031-01-15',
      frequency: 2,
      day_count: 'ACT_ACT_ICMA',
      fictional: true,
    }),
  ),
  Object.freeze(
    instrumentSchema.parse({
      id: 'SYN-CORP-2031',
      issuer: 'Fictional Meridian Industries',
      currency: 'USD',
      coupon_rate: '0.04',
      dated_date: '2025-01-15',
      maturity_date: '2031-01-15',
      frequency: 2,
      day_count: 'THIRTY_360_US',
      fictional: true,
    }),
  ),
]);
const fixed = (places: number) => z.string().regex(new RegExp(`^-?\\d+\\.\\d{${places}}$`));
export const conventions = Object.freeze({
  precision_digits: 50,
  rounding: 'ROUND_HALF_EVEN',
  price_unit: 'per 100 par',
  rate_unit: 'annual decimal fraction, semiannual compounding',
  risk_unit: 'duration years; convexity years squared; DV01 USD for stated long par',
  schedule: 'regular semiannual, unadjusted, settlement-day coupon excluded',
  valuation: 'fractional-period compound discounting; no holiday adjustment or ex-dividend',
});
export const instrumentsResponseSchema = z
  .object({ instruments: z.array(instrumentSchema).length(2) })
  .strict();
export const analyticsResponseSchema = z
  .object({
    instrument: instrumentSchema,
    settlement_date: z.string().date(),
    par_amount: fixed(2),
    yield: fixed(12),
    clean_price: fixed(10),
    dirty_price: fixed(10),
    accrued_interest: fixed(10),
    macaulay_duration: fixed(10),
    modified_duration: fixed(10),
    convexity: fixed(10),
    dv01_usd: fixed(8),
    consideration_usd: fixed(2),
    previous_coupon_date: z.string().date(),
    next_coupon_date: z.string().date(),
    remaining_coupon_dates: z.array(z.string().date()).min(1),
    conventions: z
      .object({
        precision_digits: z.literal(50),
        rounding: z.literal(conventions.rounding),
        price_unit: z.literal(conventions.price_unit),
        rate_unit: z.literal(conventions.rate_unit),
        risk_unit: z.literal(conventions.risk_unit),
        schedule: z.literal(conventions.schedule),
        valuation: z.literal(conventions.valuation),
      })
      .strict(),
  })
  .strict();
