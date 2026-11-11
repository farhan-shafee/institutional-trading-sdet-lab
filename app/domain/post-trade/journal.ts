import { z } from 'zod';
import {
  initializePostTradeSchema,
  correctPriceSchema,
  bustExecutionSchema,
  settleExecutionSchema,
  reverseSettlementSchema,
} from './contracts.js';

const base = { version: z.literal(1), sandbox_id: z.uuid(), key: z.uuid() };
const execution = { ...base, execution_id: z.uuid() };
export const postTradeIntentSchema = z.discriminatedUnion('operation', [
  z
    .object({ ...base, operation: z.literal('INITIALIZE'), body: initializePostTradeSchema })
    .strict(),
  z
    .object({ ...execution, operation: z.literal('REGISTER'), body: z.object({}).strict() })
    .strict(),
  z
    .object({
      ...execution,
      operation: z.literal('CORRECT_PRICE'),
      body: correctPriceSchema.omit({ execution_id: true }),
    })
    .strict(),
  z
    .object({
      ...execution,
      operation: z.literal('BUST'),
      body: bustExecutionSchema.omit({ execution_id: true }),
    })
    .strict(),
  z
    .object({
      ...execution,
      operation: z.literal('SETTLE'),
      body: settleExecutionSchema.omit({ execution_id: true }),
    })
    .strict(),
  z
    .object({
      ...execution,
      operation: z.literal('REVERSE'),
      body: reverseSettlementSchema.omit({ execution_id: true }),
    })
    .strict(),
]);
export type RetainedPostTradeCommand = z.infer<typeof postTradeIntentSchema>;
/** Only identified decisions with no new financial receipt. Authorization/admission/unknown errors retain intent. */
export function definitivePostTradeRejection(status: number, code: string): boolean {
  return (
    (status === 400 &&
      ['VALIDATION_ERROR', 'PROCESSING_DATE_NOT_WEEKDAY', 'QUOTE_OUTSIDE_PRICING_RANGE'].includes(
        code,
      )) ||
    (status === 404 && ['EXECUTION_NOT_FOUND', 'EXECUTION_NOT_REGISTERED'].includes(code)) ||
    (status === 409 &&
      [
        'ADJUSTMENT_REVISION_CONFLICT',
        'CORRECTION_LIMIT_REACHED',
        'EXECUTION_ALREADY_REGISTERED',
        'EXECUTION_BUSTED',
        'EXECUTION_OUTSIDE_ECONOMIC_WINDOW',
        'POSTTRADE_ALREADY_INITIALIZED',
        'POSTTRADE_NOT_INITIALIZED',
        'PROCESSING_DATE_CONFLICT',
        'SANDBOX_EXPIRED',
        'SETTLEMENT_ALREADY_REVERSED',
        'SETTLEMENT_ALREADY_POSTED',
        'SETTLEMENT_NOT_POSTED',
        'SETTLEMENT_REVERSAL_REQUIRED',
      ].includes(code)) ||
    (status === 429 &&
      ['POSTTRADE_ROOT_LIMIT', 'SETTLEMENT_FAILURE_LIMIT', 'PROTECTED_FINANCIAL_CAPACITY'].includes(
        code,
      ))
  );
}
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function postTradeCommandPath(intent: RetainedPostTradeCommand): string {
  const root = '/api/fixed-income/v1/sandboxes/' + intent.sandbox_id + '/posttrade';
  if (intent.operation === 'INITIALIZE') return root + '/initialize';
  const actions = {
    REGISTER: 'register',
    CORRECT_PRICE: 'corrections',
    BUST: 'busts',
    SETTLE: 'settlements',
    REVERSE: 'reversals',
  };
  return root + '/executions/' + intent.execution_id + '/' + actions[intent.operation];
}

/** One bounded, validated non-secret original intent per workspace. */
export class PostTradeCommandJournal {
  constructor(private readonly storage: Storage) {}
  private key(id: string) {
    return 'tradeflow.posttrade.command.v1.' + z.uuid().parse(id);
  }
  load(id: string): RetainedPostTradeCommand | undefined {
    const bytes = this.storage.getItem(this.key(id));
    if (bytes === null) return undefined;
    if (bytes.length > 4096)
      throw new Error('Retained financial request is invalid; original bytes preserved.');
    const intent = postTradeIntentSchema.parse(JSON.parse(bytes));
    if (intent.sandbox_id !== id) throw new Error('Retained financial workspace mismatch.');
    return intent;
  }
  retain(value: RetainedPostTradeCommand): RetainedPostTradeCommand {
    const intent = postTradeIntentSchema.parse(value);
    if (this.load(intent.sandbox_id))
      throw new Error('Recover the original financial request first.');
    this.storage.setItem(this.key(intent.sandbox_id), JSON.stringify(intent));
    return intent;
  }
  resolve(intent: RetainedPostTradeCommand): void {
    const saved = this.load(intent.sandbox_id);
    if (saved && JSON.stringify(saved) === JSON.stringify(postTradeIntentSchema.parse(intent)))
      this.storage.removeItem(this.key(intent.sandbox_id));
  }
  forgetEndedSession(id: string): void {
    this.storage.removeItem(this.key(id));
  }
}
