/** Controlled local/CI application. No HTTP routes, sockets or delivery. */
import { z } from 'zod';
import { decodeFix44 } from '../../protocol/fix44/index.js';
import { DomainError } from '../../domain/errors.js';
import { workflowResultSchema } from '../../domain/workflow/contracts.js';
import type { WorkflowDatabase } from '../../persistence/postgres/workflow.js';
import type { Binding } from '../fixed-income-workflow/bindings.js';
const uuid = z.uuid().transform((v) => v.toLowerCase());
export const applyFixSchema = z
  .object({
    order_id: uuid,
    owner_id: uuid,
    fence: z.string().regex(/^[1-9][0-9]{0,15}$/),
    work_id: uuid,
  })
  .strict();
export class FixApplicationService {
  constructor(
    readonly database: WorkflowDatabase,
    private readonly enabled = false,
  ) {}
  async apply(binding: Binding, actor: string, input: unknown, key: string, verify: () => void) {
    const authorize = () => {
      if (!this.enabled)
        throw new DomainError(503, 'FIX_APPLICATION_DISABLED', 'FIX application is disabled.');
      verify();
      if (binding.scope !== 'trade')
        throw new DomainError(403, 'FORBIDDEN', 'Trade ownership is required.');
    };
    authorize();
    const p = applyFixSchema.safeParse(input);
    if (!p.success || !/^[A-Za-z0-9_-]{8,128}$/.test(key) || !uuid.safeParse(actor).success)
      throw new DomainError(400, 'VALIDATION_ERROR', 'Invalid FIX application command.');
    return this.database.transaction(false, authorize, async (db) => {
      const r = await db.query<{ r: unknown }>('SELECT fi_control.apply_fix($1,$2,$3,$4,$5,$6) r', [
        binding.sandboxId,
        binding.digest,
        binding.generation,
        JSON.stringify(p.data),
        key,
        actor,
      ]);
      return workflowResultSchema.parse(r.rows[0]?.r);
    });
  }
  async ingest(binding: Binding, actor: string, input: unknown, key: string, verify: () => void) {
    const authorize = () => {
      if (!this.enabled)
        throw new DomainError(503, 'FIX_APPLICATION_DISABLED', 'FIX application is disabled.');
      verify();
      if (binding.scope !== 'trade')
        throw new DomainError(403, 'FORBIDDEN', 'Trade ownership is required.');
    };
    authorize();
    const p = z
      .object({
        order_id: uuid,
        attempt_id: uuid,
        raw_hex: z.string().regex(/^(?:[a-f0-9]{2}){1,8192}$/),
      })
      .strict()
      .safeParse(input);
    if (!p.success || !/^[A-Za-z0-9_-]{8,128}$/.test(key) || !uuid.safeParse(actor).success)
      throw new DomainError(400, 'VALIDATION_ERROR', 'Invalid controlled FIX input.');
    let valid = true;
    try {
      decodeFix44(Buffer.from(p.data.raw_hex, 'hex'));
    } catch {
      valid = false;
    }
    return this.database.transaction(false, authorize, async (db) =>
      workflowResultSchema.parse(
        (
          await db.query<{ r: unknown }>('SELECT fi_control.ingest_fix($1,$2,$3,$4,$5,$6,$7) r', [
            binding.sandboxId,
            binding.digest,
            binding.generation,
            JSON.stringify(p.data),
            key,
            actor,
            valid,
          ])
        ).rows[0]?.r,
      ),
    );
  }
}
