/** Internal opt-in metadata API. No route, transport or financial application. */
import { z } from 'zod';
import { DomainError } from '../../domain/errors.js';
import { workflowResultSchema } from '../../domain/workflow/contracts.js';
import { decodeFix44 } from '../../protocol/fix44/index.js';
import type { WorkflowDatabase } from '../../persistence/postgres/workflow.js';
import type { Binding } from '../fixed-income-workflow/bindings.js';
const uuid = z.uuid().transform((v) => v.toLowerCase());
const base = z.object({ order_id: uuid });
const inputs = {
  BIND: base.extend({ dealer_id: z.enum(['ATLAS', 'BIRCH', 'CEDAR']), channel_id: uuid }).strict(),
  RECORD: base
    .extend({ attempt_id: uuid, raw_hex: z.string().regex(/^(?:[a-f0-9]{2}){1,8192}$/) })
    .strict(),
  CLAIM: base.extend({ owner_id: uuid }).strict(),
  QUEUE: base.extend({ message_id: uuid, work_id: uuid }).strict(),
  PREPARE: base
    .extend({
      owner_id: uuid,
      fence: z.string().regex(/^[1-9][0-9]{0,15}$/),
      work_id: uuid,
      financial_key: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    })
    .strict(),
  RESOLVE_METADATA: base
    .extend({ owner_id: uuid, fence: z.string().regex(/^[1-9][0-9]{0,15}$/), work_id: uuid })
    .strict(),
  RELEASE: base.strict(),
} as const;
export type FoundationOperation = keyof typeof inputs;
export class FixFoundationService {
  constructor(
    readonly database: WorkflowDatabase,
    private readonly enabled = false,
  ) {}
  private authorize(binding: Binding, write: boolean, verify: () => void): void {
    if (!this.enabled)
      throw new DomainError(503, 'FIX_FOUNDATION_DISABLED', 'FIX foundation is disabled.');
    verify();
    if (write && binding.scope !== 'trade')
      throw new DomainError(403, 'FORBIDDEN', 'Trade ownership is required.');
  }
  async command(
    binding: Binding,
    actor: string,
    action: FoundationOperation,
    input: unknown,
    key: string,
    verify: () => void,
  ) {
    this.authorize(binding, true, verify);
    const p =
      typeof action === 'string' && Object.hasOwn(inputs, action)
        ? inputs[action].safeParse(input)
        : undefined;
    if (!p?.success || !/^[A-Za-z0-9_-]{8,128}$/.test(key) || !uuid.safeParse(actor).success)
      throw new DomainError(400, 'VALIDATION_ERROR', 'Invalid FIX metadata command.');
    if (action === 'RECORD')
      try {
        decodeFix44(Buffer.from(inputs.RECORD.parse(input).raw_hex, 'hex'));
      } catch {
        throw new DomainError(400, 'FIX_PROFILE_VIOLATION', 'Invalid FIX evidence.');
      }
    return this.database.transaction(
      false,
      () => this.authorize(binding, true, verify),
      async (db) => {
        const r = await db.query<{ result: unknown }>(
          'SELECT fi_control.fix_command($1,$2,$3,$4,$5,$6,$7) AS result',
          [
            binding.sandboxId,
            binding.digest,
            binding.generation,
            action,
            JSON.stringify(p.data),
            key,
            actor,
          ],
        );
        return workflowResultSchema.parse(r.rows[0]?.result);
      },
    );
  }
  async read(binding: Binding, kind: 'RECEIPT' | 'STATE', ref: string, verify: () => void) {
    this.authorize(binding, false, verify);
    const reference =
      kind === 'STATE'
        ? uuid.safeParse(ref)
        : z
            .string()
            .regex(/^[A-Za-z0-9_-]{8,128}$/)
            .safeParse(ref);
    if (!['RECEIPT', 'STATE'].includes(kind) || !reference.success)
      throw new DomainError(400, 'VALIDATION_ERROR', 'Invalid FIX metadata read.');
    ref = reference.data;
    return this.database.transaction(
      true,
      () => this.authorize(binding, false, verify),
      async (db) => {
        const r = await db.query<{ result: unknown }>(
          'SELECT fi_control.read_fix($1,$2,$3,$4,$5,$6) AS result',
          [binding.sandboxId, binding.digest, binding.scope, binding.generation, kind, ref],
        );
        return workflowResultSchema.parse(r.rows[0]?.result);
      },
    );
  }
}
