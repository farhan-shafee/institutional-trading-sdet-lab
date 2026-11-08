/** Internal local controller API. Explicitly enabled; no public route. */
import { z } from 'zod';
import { DomainError } from '../../domain/errors.js';
import { workflowResultSchema } from '../../domain/workflow/contracts.js';
import type { LiveWorkflowDatabase } from '../../persistence/postgres/live-workflow.js';
import type { Binding } from '../fixed-income-workflow/bindings.js';
import { applyFixSchema } from './application.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
const keySchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
const bytes = z.string().regex(/^(?:[a-f0-9]{2}){1,8192}$/);
const pid = z
  .string()
  .regex(/^[1-9][0-9]{0,9}$/)
  .refine((v) => BigInt(v) <= 2147483647n);
const base = z.object({ order_id: uuid });
const inputs = {
  BIND: base
    .extend({
      dealer_id: z.literal('ATLAS'),
      channel_id: uuid,
      session_id: uuid,
      store_id: uuid,
      connection_id: uuid,
      runtime_hash: z.string().regex(/^[a-f0-9]{64}$/),
      store_hash: z.string().regex(/^[a-f0-9]{64}$/),
      go_pid: pid,
      java_pid: pid,
    })
    .strict(),
  CONNECT: base.extend({ connection_id: uuid, go_pid: pid, java_pid: pid }).strict(),
  OBSERVE: base
    .extend({
      observation_id: uuid,
      connection_id: uuid,
      direction: z.enum(['IN', 'OUT']),
      raw_hex: bytes,
    })
    .strict(),
  ACCEPT: base
    .extend({
      observation_id: uuid,
      connection_id: uuid,
      role: z.enum(['java', 'go']),
      event_seq: z
        .string()
        .regex(/^[1-9][0-9]{0,3}$/)
        .refine((v) => Number(v) <= 1024),
      callback_hex: bytes,
    })
    .strict(),
  CLAIM: base.extend({ owner_id: uuid }).strict(),
  QUEUE: base.extend({ message_id: uuid, work_id: uuid }).strict(),
  PREPARE: applyFixSchema.extend({ financial_key: keySchema }).strict(),
  RESOLVE_METADATA: applyFixSchema,
  RELEASE: base.strict(),
} as const;
export type LiveFixOperation = keyof typeof inputs;
export class LiveFixApplicationService {
  constructor(
    readonly database: LiveWorkflowDatabase,
    private readonly enabled = false,
  ) {}
  private authorize(binding: Binding, write: boolean, verify: () => void): void {
    if (!this.enabled)
      throw new DomainError(503, 'FIX_LIVE_DISABLED', 'Live FIX application is disabled.');
    verify();
    if (write && binding.scope !== 'trade')
      throw new DomainError(403, 'FORBIDDEN', 'Trade ownership is required.');
  }
  async command(
    binding: Binding,
    actor: string,
    action: LiveFixOperation,
    input: unknown,
    key: string,
    verify: () => void,
  ) {
    this.authorize(binding, true, verify);
    const parsed =
      typeof action === 'string' && Object.hasOwn(inputs, action)
        ? inputs[action].safeParse(input)
        : undefined;
    if (!parsed?.success || !keySchema.safeParse(key).success || !uuid.safeParse(actor).success)
      throw new DomainError(400, 'VALIDATION_ERROR', 'Invalid live FIX command.');
    // OBSERVE intentionally admits malformed raw evidence. SQL computes validity;
    // only separately correlated ACCEPT evidence can become eligible.
    return this.database.transaction(
      false,
      () => this.authorize(binding, true, verify),
      async (db) =>
        workflowResultSchema.parse(
          (
            await db.query<{ r: unknown }>(
              'SELECT fi_control.fix_live_command($1,$2,$3,$4,$5,$6,$7) r',
              [
                binding.sandboxId,
                binding.digest,
                binding.generation,
                action,
                JSON.stringify(parsed.data),
                key,
                actor,
              ],
            )
          ).rows[0]?.r,
        ),
    );
  }
  async apply(binding: Binding, actor: string, input: unknown, key: string, verify: () => void) {
    this.authorize(binding, true, verify);
    const parsed = applyFixSchema.safeParse(input);
    if (!parsed.success || !keySchema.safeParse(key).success || !uuid.safeParse(actor).success)
      throw new DomainError(400, 'VALIDATION_ERROR', 'Invalid live FIX application.');
    return this.database.transaction(
      false,
      () => this.authorize(binding, true, verify),
      async (db) =>
        workflowResultSchema.parse(
          (
            await db.query<{ r: unknown }>(
              'SELECT fi_control.apply_live_fix($1,$2,$3,$4,$5,$6) r',
              [
                binding.sandboxId,
                binding.digest,
                binding.generation,
                JSON.stringify(parsed.data),
                key,
                actor,
              ],
            )
          ).rows[0]?.r,
        ),
    );
  }
  async read(binding: Binding, kind: 'STATE' | 'RECEIPT', ref: string, verify: () => void) {
    this.authorize(binding, false, verify);
    const parsed = kind === 'STATE' ? uuid.safeParse(ref) : keySchema.safeParse(ref);
    if (!['STATE', 'RECEIPT'].includes(kind) || !parsed.success)
      throw new DomainError(400, 'VALIDATION_ERROR', 'Invalid live FIX read.');
    return this.database.transaction(
      true,
      () => this.authorize(binding, false, verify),
      async (db) =>
        workflowResultSchema.parse(
          (
            await db.query<{ r: unknown }>('SELECT fi_control.read_live_fix($1,$2,$3,$4,$5,$6) r', [
              binding.sandboxId,
              binding.digest,
              binding.scope,
              binding.generation,
              kind,
              parsed.data,
            ])
          ).rows[0]?.r,
        ),
    );
  }
}
