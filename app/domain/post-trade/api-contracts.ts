import { z } from 'zod';
import { curveSnapshotSchema } from '../fixed-income-v3/contracts.js';
import { curveFixtureIds } from '../fixed-income-v3/wire-identifiers.js';
import {
  assessmentModel,
  assessmentReasons,
  dollarRiskModel,
  fifoModel,
} from './wire-identifiers.js';
import { settlementModel, initializePostTradeSchema } from './contracts.js';
import { ownedSourceSchema, ownedRootSchema, availableSecuritySchema } from './source.js';

const date = initializePostTradeSchema.shape.economic_start_date;
const integer = (max: bigint) =>
  z
    .string()
    .regex(/^(0|[1-9][0-9]{0,2})$/)
    .refine((value) => BigInt(value) <= max);
const sequence = integer(97n).refine((value) => BigInt(value) > 0n);
const cents = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,13})$/)
  .refine((value) => BigInt(value) <= 10002000000000n);
const fixed = (n: number) =>
  z
    .string()
    .max(40)
    .regex(new RegExp('^-?\\d+\\.\\d{' + n + '}$'));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const utc = z.iso.datetime().refine((value) => value.endsWith('Z'));
const revision = z.number().int().min(0).max(2);
const fraction = z
  .object({
    numerator: z.string().regex(/^-?(0|[1-9][0-9]{0,255})$/),
    denominator: z.string().regex(/^[1-9][0-9]{0,255}$/),
  })
  .strict();
export const postTradeSourceQuerySchema = z
  .object({
    raw_as_of_seq: integer(512n).optional(),
    posttrade_as_of_seq: integer(97n).optional(),
  })
  .strict();
export const portfolioQuerySchema = postTradeSourceQuerySchema
  .extend({
    fixture_id: z.enum(curveFixtureIds),
    as_of_date: date,
  })
  .strict();
export const postTradeAuditQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-9][0-9]|100)$/)
      .optional(),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict();
export const postTradeErrorSchema = z
  .object({
    error: z
      .object({ code: z.string().regex(/^[A-Z0-9_]{1,64}$/), message: z.string().min(1).max(256) })
      .strict(),
  })
  .strict();
const initBody = z
  .object({
    model_version: z.literal('OWNED_POSTTRADE_SOURCE_V1'),
    settlement_model_version: z.literal(settlementModel),
    sandbox_id: z.uuid(),
    window: ownedSourceSchema.shape.window.unwrap(),
    opening_cash_cents: z.literal('10000000000'),
    posttrade_command_seq: z.literal('1'),
  })
  .strict();
const registerBody = z
  .object({ execution_id: z.uuid(), revision: z.literal(0), posttrade_command_seq: sequence })
  .strict();
const correctionBody = z
  .object({
    execution_id: z.uuid(),
    revision: z.union([z.literal(1), z.literal(2)]),
    clean_price: ownedRootSchema.shape.original_clean_price,
    consideration_cents: cents,
    posttrade_command_seq: sequence,
    recorded_at: utc,
  })
  .strict();
const bustBody = z
  .object({
    execution_id: z.uuid(),
    revision,
    busted: z.literal(true),
    posttrade_command_seq: sequence,
    recorded_at: utc,
  })
  .strict();
const settlementBase = z
  .object({
    execution_id: z.uuid(),
    revision,
    settlement_model_version: z.literal(settlementModel),
    processing_date: date,
    outcome_id: z.uuid(),
    posttrade_command_seq: sequence,
    recorded_at: utc,
  })
  .strict();
const failedBody = settlementBase
  .extend({
    settlement_state: z.literal('FAILED'),
    reason: z.enum(['INSUFFICIENT_CASH', 'INSUFFICIENT_SECURITIES']),
  })
  .strict();
const settledBody = settlementBase.extend({ settlement_state: z.literal('SETTLED') }).strict();
const reversedBody = settlementBase.extend({ settlement_state: z.literal('REVERSED') }).strict();
export const postTradeMutationSchemas = {
  INITIALIZE: initBody,
  REGISTER: registerBody,
  CORRECT_PRICE: correctionBody,
  BUST: bustBody,
  SETTLE: settledBody,
  REVERSE: reversedBody,
} as const;
export const postTradeFailureBodySchema = failedBody;
export type PostTradeOperation = keyof typeof postTradeMutationSchemas;

export const assessmentSourceSchema = z
  .object({
    source_model_version: z.literal('OWNED_POSTTRADE_SOURCE_V1'),
    source_id: hash,
    sandbox_id: z.uuid(),
    generation: ownedSourceSchema.shape.generation,
    raw_command_seq: integer(512n),
    last_execution_command_seq: integer(512n),
    posttrade_command_seq: integer(97n),
    last_adjustment_seq: integer(97n),
    initialized: z.boolean(),
    raw_execution_count: ownedSourceSchema.shape.raw_execution_count,
    window: ownedSourceSchema.shape.window,
    processing_date_watermark: date.nullable(),
    balance_basis: z.literal('POSTTRADE_SOURCE_SEQUENCE'),
  })
  .strict();
const dollarRisk = z
  .object({
    pv_usd: fixed(2),
    parallel_dv01_usd: fixed(8),
    key_rate_dv01_usd: z.tuple([fixed(8), fixed(8), fixed(8), fixed(8)]),
    stress_pnl_usd: z
      .object({ PARALLEL_UP_100: fixed(8), PARALLEL_DOWN_100: fixed(8), STEEPENER_V1: fixed(8) })
      .strict(),
  })
  .strict();
const instrumentRisk = (id: 'SYN-UST-2031' | 'SYN-CORP-2031', definition: string) =>
  dollarRisk
    .extend({
      instrument_id: z.literal(id),
      definition_version: z.literal(definition),
      signed_par: fixed(2),
    })
    .strict();
export const portfolioRiskSchema = z
  .object({
    total: dollarRisk,
    instruments: z.tuple([
      instrumentRisk('SYN-UST-2031', 'phase1-ust-1'),
      instrumentRisk('SYN-CORP-2031', 'phase1-corp-1'),
    ]),
  })
  .strict();
export const portfolioPnlSchema = z
  .object({
    opening_cash_usd: z.literal('100000000.00'),
    available_cash_usd: fixed(2).refine((value) => !value.startsWith('-')),
    signed_unsettled_cash_usd: fixed(2),
    economic_security_mark_usd: fixed(2),
    equity_usd: fixed(2),
    realized_pnl_usd: fixed(2),
    realized_pnl_exact_usd: fraction,
    unrealized_pnl_usd: fixed(2),
    total_pnl_usd: fixed(2),
    presentation_rounding_delta_usd: fixed(2),
    available_securities: z
      .array(
        availableSecuritySchema
          .extend({
            available_par: availableSecuritySchema.shape.available_par.refine(
              (value) => value.split('.')[1]?.length === 2,
            ),
          })
          .strict(),
      )
      .length(2)
      .refine((rows) => new Set(rows.map((row) => row.instrument_id)).size === 2),
    lots: z
      .array(
        z
          .object({
            opening_execution_id: z.uuid(),
            instrument_id: z.enum(['SYN-UST-2031', 'SYN-CORP-2031']),
            side: z.enum(['LONG', 'SHORT']),
            remaining_par: fixed(2),
            remaining_basis_or_proceeds_exact_usd: fraction,
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
const common = z
  .object({
    model_version: z.literal(assessmentModel),
    assessment_id: hash,
    source: assessmentSourceSchema,
    curve: curveSnapshotSchema,
    as_of_date: date,
    currency: z.literal('USD'),
    models: z
      .object({
        risk: z.literal(dollarRiskModel),
        fifo: z.literal(fifoModel),
        settlement: z.literal(settlementModel),
      })
      .strict(),
  })
  .strict();
const unavailable = common
  .extend({
    status: z.literal('UNAVAILABLE'),
    reasons: z.array(z.enum(assessmentReasons)).min(1).max(11),
  })
  .strict();
export const riskAssessmentSchema = z
  .discriminatedUnion('status', [
    unavailable,
    common.extend({ status: z.literal('AVAILABLE'), risk: portfolioRiskSchema }).strict(),
  ])
  .refine((value) => value.as_of_date === value.curve.as_of_date);
export const pnlAssessmentSchema = z
  .discriminatedUnion('status', [
    unavailable,
    common.extend({ status: z.literal('AVAILABLE'), pnl: portfolioPnlSchema }).strict(),
  ])
  .refine((value) => value.as_of_date === value.curve.as_of_date);
export const commandReceiptSchema = z
  .object({
    command: z
      .object({
        id: z.uuid(),
        idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
        operation: z.enum(['INITIALIZE', 'REGISTER', 'CORRECT_PRICE', 'BUST', 'SETTLE', 'REVERSE']),
        command_seq: sequence,
        capability_generation: ownedSourceSchema.shape.generation,
        actor_id: z.uuid(),
        http_status: z.union([z.literal(200), z.literal(201), z.literal(409)]),
        request_hash: hash,
        request_payload: z.record(z.string(), z.unknown()),
        response_body: z.record(z.string(), z.unknown()),
        recorded_at: utc,
      })
      .strict(),
  })
  .strict();
export const postTradeHistorySchema = z
  .object({
    source: assessmentSourceSchema,
    registered: z.boolean(),
    original_execution: z
      .object({
        execution_id: z.uuid(),
        source_event_id: z.uuid(),
        order_id: z.uuid(),
        fill_sequence: z.number().int().min(1).max(8),
        raw_command_seq: ownedRootSchema.shape.command_seq,
        instrument_id: ownedRootSchema.shape.instrument_id,
        definition_version: ownedRootSchema.shape.definition_version,
        side: ownedRootSchema.shape.side,
        par_amount: ownedRootSchema.shape.par_amount,
        quoted_settlement_date: date,
        original_clean_price: ownedRootSchema.shape.original_clean_price,
        original_consideration_cents: ownedRootSchema.shape.original_consideration_cents,
        raw_decided_at: utc,
        raw_recorded_at: utc,
      })
      .strict(),
    revisions: z
      .array(
        z
          .object({
            revision,
            clean_price: ownedRootSchema.shape.original_clean_price,
            consideration_cents: cents,
            posttrade_command_seq: sequence,
            recorded_at: utc,
          })
          .strict(),
      )
      .max(3),
    bust: z
      .object({ revision, posttrade_command_seq: sequence, recorded_at: utc })
      .strict()
      .nullable(),
    settlement_outcomes: z
      .array(
        z
          .object({
            outcome_id: z.uuid(),
            revision,
            outcome: z.enum(['FAILED', 'SETTLED', 'REVERSED']),
            processing_date: date,
            reason: z.enum(['INSUFFICIENT_CASH', 'INSUFFICIENT_SECURITIES']).nullable(),
            posting_id: z.uuid().nullable(),
            posttrade_command_seq: sequence,
            recorded_at: utc,
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export const postTradeAuditEventSchema = z
  .object({
    command_seq: sequence,
    event_index: z.number().int().min(0).max(1),
    event_type: z.enum([
      'FUNDING',
      'REGISTERED',
      'COMPENSATE',
      'REPLACEMENT',
      'BUST',
      'SETTLEMENT_FAILED',
      'CASH_POSTED',
      'SECURITY_POSTED',
      'CASH_REVERSED',
      'SECURITY_REVERSED',
    ]),
    execution_id: z.uuid().nullable(),
    definition_version: z.string().min(1).max(128).nullable(),
    economic_cash_cents: z.string().regex(/^-?[0-9]{1,14}$/),
    economic_par_change: fixed(2),
    available_cash_cents: z.string().regex(/^-?[0-9]{1,14}$/),
    available_par_change: fixed(2),
    counterparty_cash_cents: z.string().regex(/^-?[0-9]{1,14}$/),
    counterparty_par_change: fixed(2),
    actor_id: z.uuid(),
    recorded_at: utc,
  })
  .strict();
export const postTradeAuditSchema = z
  .object({
    source: assessmentSourceSchema,
    events: z.array(postTradeAuditEventSchema).max(100),
    as_of_seq: integer(97n),
    next_cursor: z.string().max(1024).nullable(),
  })
  .strict();
