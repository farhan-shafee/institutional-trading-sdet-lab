import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { rfqDetailSchema, versionSchema } from './rfq.js';
const uuid = z.uuid().transform((v) => v.toLowerCase());
const par = z
  .string()
  .regex(/^\d{1,10}(?:\.\d{1,2})?$/)
  .refine((v) => new Decimal(v).gte('0.01') && new Decimal(v).lte('1000000000'))
  .transform((v) => new Decimal(v).toFixed(2));
export const orderVersionSchema = z.object({ expected_version: versionSchema }).strict();
export const executionCommandSchema = orderVersionSchema
  .extend({ execution_id: uuid, source_event_id: uuid, par_amount: par })
  .strict();
export const cancelCommandSchema = orderVersionSchema.extend({ cancel_id: uuid }).strict();
const amount = z.string().regex(/^\d{1,10}\.\d{2}$/);
const integer = z.string().regex(/^\d+$/);
export const lifecycleSchema = z
  .object({
    status: z.enum(['PENDING_ACK', 'NEW', 'REJECTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED']),
    version: versionSchema,
    filled_par: amount,
    remaining_par: amount,
    executed_cents: integer,
    execution_count: z.number().int().min(0).max(8),
    pending_cancel_id: z.uuid().nullable(),
    decided_at: z.iso.datetime(),
    recorded_at: z.iso.datetime(),
  })
  .strict();
export const executionSchema = z
  .object({
    id: z.uuid(),
    source_event_id: z.uuid(),
    order_id: z.uuid(),
    fill_sequence: z.number().int().min(1).max(8),
    par_amount: amount,
    clean_price: z.string().regex(/^\d{1,5}\.\d{12}$/),
    instrument_revision: z.enum(['phase1-ust-1', 'phase1-corp-1']),
    settlement_date: z.string().date(),
    side: z.enum(['BUY', 'SELL']),
    accrual_elapsed: z.number().int().min(0).max(184),
    accrual_period: z.number().int().min(180).max(184),
    consideration_cents: integer,
    command_id: z.uuid(),
    command_seq: integer,
    event_index: z.literal(0),
    decided_at: z.iso.datetime(),
    recorded_at: z.iso.datetime(),
  })
  .strict();
export const cancellationSchema = z
  .object({
    id: z.uuid(),
    order_id: z.uuid(),
    request_sequence: z.number().int().min(1).max(8),
    state: z.enum(['PENDING', 'ACKNOWLEDGED', 'REJECTED']),
    reason: z.enum(['CANCELED_REMAINDER', 'SIMULATED_REJECTION', 'TOO_LATE']).nullable(),
    command_id: z.uuid(),
    command_seq: integer,
    decided_at: z.iso.datetime(),
    outcome_command_id: z.uuid().nullable(),
    outcome_command_seq: integer.nullable(),
  })
  .strict();
export const orderCommandResultSchema = z
  .object({
    order_id: z.uuid(),
    lifecycle: lifecycleSchema,
    execution: executionSchema.optional(),
    cancellation: cancellationSchema.optional(),
  })
  .strict();
export const orderDetailSchema = z
  .object({
    order: rfqDetailSchema.shape.order.unwrap(),
    lifecycle: lifecycleSchema,
    history: z
      .array(
        z
          .object({
            version: versionSchema,
            operation: z.enum([
              'CONTRACT_CREATED',
              'ACK_ORDER',
              'REJECT_ORDER',
              'EXECUTE_ORDER',
              'REQUEST_CANCEL',
              'ACK_CANCEL',
              'REJECT_CANCEL',
            ]),
            state: lifecycleSchema,
            command_id: z.uuid().nullable(),
            command_seq: integer.nullable(),
            decided_at: z.iso.datetime(),
          })
          .strict(),
      )
      .max(26),
    executions: z.array(executionSchema).max(8),
    cancellations: z.array(cancellationSchema).max(8),
  })
  .strict();
export const orderListSchema = z
  .object({
    orders: z
      .array(z.object({ id: z.uuid(), rfq_id: z.uuid(), lifecycle: lifecycleSchema }).strict())
      .max(50),
  })
  .strict();
export const positionsSchema = z
  .object({
    positions: z
      .array(
        z
          .object({
            instrument_revision: z.enum(['phase1-ust-1', 'phase1-corp-1']),
            instrument_id: z.enum(['SYN-UST-2031', 'SYN-CORP-2031']),
            signed_par: z.string().regex(/^-?\d{1,12}\.\d{2}$/),
            signed_cash_cents: z.string().regex(/^-?\d+$/),
            execution_count: z.number().int().min(1).max(400),
            last_command_seq: integer,
            updated_at: z.iso.datetime(),
          })
          .strict(),
      )
      .max(2),
  })
  .strict();
export type OrderDetail = z.infer<typeof orderDetailSchema>;
export type OrderCommandResult = z.infer<typeof orderCommandResultSchema>;
