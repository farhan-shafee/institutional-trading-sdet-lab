import { z } from 'zod';
import { curveDefinitionVersions, curveInstrumentIds } from './cash-flows.js';
import { curveFixtureIds } from './curves.js';

const fixed = (places: number) => z.string().regex(new RegExp('^-?\\d+\\.\\d{' + places + '}$'));
const decimalInput = z
  .string()
  .max(24)
  .regex(/^-?\d{1,10}(?:\.\d{1,12})?$/);
export const curveSnapshotQuerySchema = z
  .object({
    fixture_id: z.enum(curveFixtureIds),
    as_of_date: z.string().length(10),
  })
  .strict();
export const curveQuerySchema = curveSnapshotQuerySchema
  .extend({
    instrument_id: z.enum(curveInstrumentIds),
    par_amount: z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/),
    z_spread: decimalInput.optional(),
    clean_price: decimalInput.optional(),
  })
  .strict()
  .refine((q) => (q.z_spread === undefined) !== (q.clean_price === undefined));
const node = (offset: number) =>
  z
    .object({
      offset_days: z.literal(offset),
      zero_rate: fixed(12),
      discount_factor: fixed(20),
    })
    .strict();
export const curveSnapshotSchema = z
  .object({
    version: z.literal(1),
    model_version: z.literal('DISCOUNT_LOG_LINEAR_ACT365F_V1'),
    currency: z.literal('USD'),
    fixture_id: z.enum(curveFixtureIds),
    as_of_date: z.string().date(),
    nodes: z.tuple([node(365), node(730), node(1825), node(3650)]),
    snapshot_id: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const curveConventions = Object.freeze({
  curve_time_basis: 'ACT_365F',
  interpolation: 'LOG_LINEAR_DISCOUNT_FACTOR',
  spread_compounding: 'CONTINUOUS',
  precision_digits: 80,
  rounding: 'ROUND_HALF_EVEN',
  price_unit: 'per 100 par',
  valuation_unit: 'USD mark, not settlement cash',
  discount_factor_decimals: 20,
} as const);
export const curveAnalyticsSchema = z
  .object({
    model_version: z.literal('DISCOUNT_LOG_LINEAR_ACT365F_V1'),
    instrument_id: z.enum(curveInstrumentIds),
    definition_version: z.string().min(1),
    curve: curveSnapshotSchema,
    as_of_date: z.string().date(),
    par_amount: fixed(2),
    z_spread: fixed(12),
    clean_price: fixed(10),
    dirty_price: fixed(10),
    accrued_interest: fixed(10),
    mark_value_usd: fixed(2),
    remaining_cash_flows: z
      .array(
        z
          .object({
            payment_date: z.string().date(),
            days: z.number().int().min(1).max(3650),
            amount_per_100: fixed(10),
            discount_factor: fixed(20),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    conventions: z
      .object({
        curve_time_basis: z.literal(curveConventions.curve_time_basis),
        interpolation: z.literal(curveConventions.interpolation),
        spread_compounding: z.literal(curveConventions.spread_compounding),
        precision_digits: z.literal(80),
        rounding: z.literal(curveConventions.rounding),
        price_unit: z.literal(curveConventions.price_unit),
        valuation_unit: z.literal(curveConventions.valuation_unit),
        discount_factor_decimals: z.literal(20),
      })
      .strict(),
  })
  .strict()
  .refine(
    (value) =>
      value.definition_version === curveDefinitionVersions[value.instrument_id] &&
      value.as_of_date === value.curve.as_of_date,
  );
export type CurveAnalytics = z.infer<typeof curveAnalyticsSchema>;
