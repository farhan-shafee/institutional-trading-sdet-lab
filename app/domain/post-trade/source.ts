import { z } from 'zod';
import { curveDate } from '../fixed-income-v3/cash-flows.js';
import { Rational } from '../fixed-income-v3/numbers.js';
import { settlementModel } from './contracts.js';

const financialDate = z
  .string()
  .length(10)
  .refine((value) => {
    try {
      curveDate(value);
      return true;
    } catch {
      return false;
    }
  });
const endDate = z
  .string()
  .length(10)
  .refine((value) => value === '2031-01-15' || financialDate.safeParse(value).success);
const sequence = (max: bigint) =>
  z
    .string()
    .regex(/^(0|[1-9][0-9]{0,2})$/)
    .refine((value) => BigInt(value) <= max);
const unsigned = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,13})$/)
  .refine((value) => BigInt(value) <= 80010000000000n);
const cash = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,13})$/)
  .refine((value) => BigInt(value) <= 10002000000000n);
const par = z
  .string()
  .regex(/^\d{1,10}\.\d{2}$/)
  .refine((value) => {
    const q = Rational.decimal(value).toDecimal();
    return q.gte('0.01') && q.lte('1000000000');
  });
const clean = z.string().regex(/^[0-9]{1,5}\.[0-9]{12}$/);
const utc = z.iso
  .datetime({ offset: true })
  .refine((value) => value.endsWith('Z') || value.endsWith('+00:00'));
export const ownedRootSchema = z
  .object({
    execution_id: z.uuid(),
    command_seq: sequence(512n).refine((value) => BigInt(value) > 0n),
    instrument_id: z.string().min(1).max(64),
    definition_version: z.string().min(1).max(128),
    side: z.enum(['BUY', 'SELL']),
    par_amount: par,
    value_date: financialDate,
    original_consideration_cents: cash.refine((value) => BigInt(value) > 0n),
    original_clean_price: clean,
    raw_recorded_at: utc,
    registered: z.boolean(),
    registration_seq: sequence(97n)
      .refine((value) => BigInt(value) >= 2n)
      .nullable(),
    current_revision: z.number().int().min(0).max(2).nullable(),
    active_clean_price: clean.nullable(),
    active_consideration_cents: cash.nullable(),
    busted: z.boolean(),
    settlement_state: z.enum(['PENDING', 'FAILED', 'SETTLED', 'REVERSED', 'VOIDED']).nullable(),
  })
  .strict();
export const availableSecuritySchema = z
  .object({
    instrument_id: z.enum(['SYN-UST-2031', 'SYN-CORP-2031']),
    available_par: z
      .string()
      .regex(/^\d{1,10}(?:\.\d{1,2})?$/)
      .refine((value) => {
        const n = Rational.decimal(value).toDecimal();
        return n.gte(0) && n.lte('8000000000');
      }),
  })
  .strict();
export const sourceReasonSchema = z.enum([
  'POSTTRADE_NOT_INITIALIZED',
  'ROOT_LIMIT_EXCEEDED',
  'UNREGISTERED_EXECUTION',
  'EXECUTION_OUTSIDE_ECONOMIC_WINDOW',
  'SOURCE_CUTOFF_INCOHERENT',
]);
export const ownedSourceSchema = z
  .object({
    model_version: z.literal('OWNED_POSTTRADE_SOURCE_V1'),
    settlement_model_version: z.literal(settlementModel),
    sandbox_id: z.uuid(),
    generation: z
      .string()
      .regex(/^[1-9][0-9]{0,9}$/)
      .refine((value) => BigInt(value) <= 1000000000n),
    raw_command_seq: sequence(512n),
    last_execution_command_seq: sequence(512n),
    posttrade_command_seq: sequence(97n),
    last_adjustment_seq: sequence(97n),
    initialized: z.boolean(),
    window: z.object({ start: financialDate, end: endDate }).strict().nullable(),
    opening_cash_cents: z.literal('10000000000').nullable(),
    available_cash_cents: unsigned.nullable(),
    available_securities: z
      .array(availableSecuritySchema)
      .length(2)
      .refine((rows) => new Set(rows.map((row) => row.instrument_id)).size === 2)
      .nullable(),
    processing_date_watermark: financialDate.nullable(),
    raw_execution_count: z.number().int().min(0).max(512),
    inventory_truncated: z.boolean(),
    roots: z.array(ownedRootSchema).max(8),
    coverage: z
      .object({ complete: z.boolean(), reasons: z.array(sourceReasonSchema).max(5) })
      .strict(),
  })
  .strict();
export type OwnedPostTradeSnapshot = z.infer<typeof ownedSourceSchema>;
export type OwnedRoot = z.infer<typeof ownedRootSchema>;
