import { z } from 'zod';
import { Decimal } from 'decimal.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
export const dealerSchema = z.enum(['ATLAS', 'BIRCH', 'CEDAR']);
export const versionSchema = z.string().regex(/^[1-9][0-9]{0,2}$/);
export const quantitySchema = z
  .string()
  .regex(/^\d{1,10}(?:\.\d{1,2})?$/)
  .refine((v) => new Decimal(v).gte(1) && new Decimal(v).lte('1000000000'))
  .transform((v) => new Decimal(v).toFixed(2));
export const createRfqSchema = z
  .object({
    rfq_id: uuid,
    instrument_id: z.enum(['SYN-UST-2031', 'SYN-CORP-2031']),
    side: z.enum(['BUY', 'SELL']),
    par_amount: quantitySchema,
    settlement_date: z
      .string()
      .date()
      .refine((v) => v >= '2025-01-15' && v < '2031-01-15'),
    invited_dealers: z
      .array(dealerSchema)
      .min(1)
      .max(3)
      .refine((v) => new Set(v).size === v.length)
      .transform((v) => [...v].sort()),
  })
  .strict();
export const dealerResponseSchema = z
  .object({
    expected_version: versionSchema,
    dealer_id: dealerSchema,
    response: z.enum(['QUOTE', 'DECLINE']),
  })
  .strict();
export const quoteCommandSchema = z
  .object({ expected_version: versionSchema, quote_id: uuid })
  .strict();
export const contractualPrice = z.string().regex(/^\d{1,5}\.\d{12}$/);
const instrumentTerms = z
  .object({
    currency: z.literal('USD'),
    dated_date: z.literal('2025-01-15'),
    first_coupon_date: z.literal('2025-07-15'),
    maturity_date: z.literal('2031-01-15'),
    coupon_rate: z.literal('0.04'),
    frequency: z.literal(2),
    day_count: z.enum(['ACT_ACT_ICMA', 'THIRTY_360_US']),
  })
  .strict();
export const quoteSnapshotSchema = z
  .object({
    quote_id: z.uuid(),
    rfq_id: z.uuid(),
    dealer_id: dealerSchema,
    instrument_id: z.enum(['SYN-UST-2031', 'SYN-CORP-2031']),
    instrument_revision: z.enum(['phase1-ust-1', 'phase1-corp-1']),
    financial_source: z.literal('6016fb700840d081fe1fba651c918f0a7e709383'),
    instrument_terms: instrumentTerms,
    model_version: z.literal('synthetic-dealer-grid-v1'),
    currency: z.literal('USD'),
    price_unit: z.literal('per 100 par'),
    side: z.enum(['BUY', 'SELL']),
    par_amount: z.string().regex(/^\d{1,10}\.\d{2}$/),
    settlement_date: z.string().date(),
    bid_clean_price: contractualPrice,
    ask_clean_price: contractualPrice,
    quoted_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
  })
  .strict();
export const rfqSchema = z
  .object({
    id: z.uuid(),
    instrument_id: z.enum(['SYN-UST-2031', 'SYN-CORP-2031']),
    instrument_revision: z.enum(['phase1-ust-1', 'phase1-corp-1']),
    side: z.enum(['BUY', 'SELL']),
    par_amount: z.string().regex(/^\d{1,10}\.\d{2}$/),
    settlement_date: z.string().date(),
    version: versionSchema,
    state: z.enum(['OPEN', 'ACCEPTED', 'EXPIRED']),
    accepted_quote_id: z.uuid().nullable(),
    created_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
  })
  .strict();
export const rfqDetailSchema = z
  .object({
    rfq: rfqSchema,
    invitations: z
      .array(
        z
          .object({
            dealer_id: dealerSchema,
            state: z.enum(['INVITED', 'QUOTED', 'DECLINED', 'WITHDRAWN']),
          })
          .strict(),
      )
      .max(3),
    quotes: z
      .array(
        z
          .object({
            id: z.uuid(),
            rfq_id: z.uuid(),
            dealer_id: dealerSchema,
            bid_clean_price: contractualPrice,
            ask_clean_price: contractualPrice,
            created_at: z.iso.datetime(),
            expires_at: z.iso.datetime(),
            snapshot: quoteSnapshotSchema,
            status: z.enum(['QUOTED', 'ACCEPTED', 'WITHDRAWN', 'EXPIRED', 'UNAVAILABLE']),
          })
          .strict(),
      )
      .max(3),
    order: z
      .object({
        id: z.uuid(),
        rfq_id: z.uuid(),
        quote_id: z.uuid(),
        status: z.literal('PENDING_ACK'),
        created_at: z.iso.datetime(),
        contract: quoteSnapshotSchema.extend({ clean_price: contractualPrice }).strict(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const rfqListSchema = z.object({ rfqs: z.array(rfqSchema).max(50) }).strict();
export type RfqDetail = z.infer<typeof rfqDetailSchema>;
