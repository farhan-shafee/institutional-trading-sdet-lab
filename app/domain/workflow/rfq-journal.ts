import { z } from 'zod';
import { createRfqSchema, dealerResponseSchema, quoteCommandSchema } from './rfq.js';

const legacyKey = 'tradeflow.rfq.command.v1';
const retainedSchema = z
  .object({
    sandbox_id: z.uuid(),
    key: z.uuid(),
    path: z
      .string()
      .regex(
        /^\/api\/fixed-income\/v1\/sandboxes\/[a-f0-9-]{36}\/rfqs(?:\/[a-f0-9-]{36}\/(?:dealer-responses|withdraw|accept))?$/,
      ),
    body: z.union([createRfqSchema, dealerResponseSchema, quoteCommandSchema]),
  })
  .strict()
  .refine((v) => v.path.startsWith(`/api/fixed-income/v1/sandboxes/${v.sandbox_id}/rfqs`));
export type RetainedRfqCommand = z.infer<typeof retainedSchema>;
type JournalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Retains only validated non-secret command material, separately for each sandbox. */
export class RfqCommandJournal {
  constructor(private readonly storage: JournalStorage) {}
  private key(id: string) {
    return `${legacyKey}.${z.uuid().parse(id).toLowerCase()}`;
  }
  private parse(value: string): RetainedRfqCommand {
    try {
      return retainedSchema.parse(JSON.parse(value));
    } catch {
      throw new Error('Retained RFQ command is invalid; its original material was preserved.');
    }
  }
  load(id: string): RetainedRfqCommand | undefined {
    const key = this.key(id);
    const raw = this.storage.getItem(key);
    if (raw !== null) {
      const saved = this.parse(raw);
      if (saved.sandbox_id !== id) throw new Error('Retained RFQ sandbox mismatch.');
      return saved;
    }
    // Preserve replay for users of the unmerged candidate's previous single-journal layout.
    const legacy = this.storage.getItem(legacyKey);
    if (legacy === null) return undefined;
    const saved = this.parse(legacy);
    if (saved.sandbox_id !== id) return undefined;
    this.storage.setItem(key, legacy); // Retain scoped bytes before removing the old entry.
    this.storage.removeItem(legacyKey);
    return saved;
  }
  has(id?: string): boolean {
    return id !== undefined && this.load(id) !== undefined;
  }
  retain(command: RetainedRfqCommand): RetainedRfqCommand {
    const saved = retainedSchema.parse(command);
    if (this.load(saved.sandbox_id))
      throw new Error('Resolve the retained command before another mutation.');
    this.storage.setItem(this.key(saved.sandbox_id), JSON.stringify(saved));
    return saved;
  }
  resolve(command: RetainedRfqCommand): void {
    const saved = this.load(command.sandbox_id);
    if (saved && JSON.stringify(saved) === JSON.stringify(retainedSchema.parse(command)))
      this.storage.removeItem(this.key(command.sandbox_id));
  }
}

/** These database quota decisions happen under the sandbox lock AFTER receipt lookup.
 * Admission 429, authorization failures, missing records and uncertain outcomes are not resolution evidence.
 */
export function definitiveRfqRejection(status: number, code: string): boolean {
  return (
    (status === 409 && code !== 'IDEMPOTENCY_KEY_REUSED') ||
    (status === 429 && ['RFQ_CAPACITY_REACHED', 'SANDBOX_QUOTA_REACHED'].includes(code))
  );
}
