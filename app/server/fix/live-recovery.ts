/** Explicit recovery of a durable original request. Never repairs a missing callback. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../../domain/errors.js';
import type { Binding } from '../fixed-income-workflow/bindings.js';
import type { LiveFixApplicationService } from './live-application.js';
import type { LiveJournal } from './live-journal.js';

const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = z
  .object({
    kind: z.enum(['COMMAND', 'APPLY']),
    action: z.enum([
      'BIND',
      'CONNECT',
      'OBSERVE',
      'ACCEPT',
      'CLAIM',
      'QUEUE',
      'PREPARE',
      'RESOLVE_METADATA',
      'RELEASE',
      'APPLY',
    ]),
    order_id: uuid,
    sandbox_id: uuid,
    actor_id: uuid,
    input: z.record(z.string(), z.string()),
    witness: z.unknown().optional(),
  })
  .strict();
const witnessSchema = z
  .object({
    profile: z.literal('live-fix-ingress-v1'),
    runtime_hash: hash,
    session_id: uuid,
    store_id: uuid,
    connection_id: uuid,
    role: z.enum(['go', 'java']),
    pid: z
      .string()
      .regex(/^[1-9][0-9]{0,9}$/)
      .refine((v) => BigInt(v) <= 2147483647n),
    event_seq: z
      .string()
      .regex(/^[1-9][0-9]{0,3}$/)
      .refine((v) => Number(v) <= 1024),
    callback_hash: hash,
  })
  .strict();
function failure(code: string) {
  return new DomainError(
    503,
    code,
    'Recover the original durable request. Missing native callback evidence remains unresolved.',
  );
}

export async function recoverLiveRequest(
  service: LiveFixApplicationService,
  binding: Binding,
  actor: string,
  journal: LiveJournal,
  key: string,
  verify: () => void,
  enabled = false,
) {
  if (!enabled) throw failure('FIX_LIVE_RECOVERY_DISABLED');
  verify();
  if (!uuid.safeParse(key).success) throw failure('FIX_LIVE_ORIGINAL_INTENT_REQUIRED');
  const parsed = requestSchema.safeParse(await journal.read('request', key));
  if (!parsed.success) throw failure('FIX_LIVE_ORIGINAL_INTENT_REQUIRED');
  const original = parsed.data;
  if (original.sandbox_id !== binding.sandboxId || original.actor_id !== actor)
    throw new DomainError(404, 'SANDBOX_NOT_FOUND', 'Sandbox not found.');
  if (
    original.order_id !== original.input['order_id'] ||
    (original.kind === 'APPLY') !== (original.action === 'APPLY')
  )
    throw failure('FIX_LIVE_ORIGINAL_INTENT_REQUIRED');
  if (
    original.action === 'BIND' &&
    (original.input['session_id'] !== journal.identity.session_id ||
      original.input['store_id'] !== journal.identity.store_id ||
      original.input['runtime_hash'] !== journal.identity.runtime_hash)
  )
    throw failure('FIX_LIVE_ORIGINAL_INTENT_REQUIRED');
  if (original.action === 'ACCEPT') {
    const witness = witnessSchema.safeParse(original.witness),
      raw = z
        .string()
        .regex(/^(?:[a-f0-9]{2}){1,8192}$/)
        .safeParse(original.input['callback_hex']);
    if (!witness.success || !raw.success) throw failure('FIX_LIVE_CALLBACK_UNRESOLVED');
    const w = witness.data;
    if (
      w.runtime_hash !== journal.identity.runtime_hash ||
      w.session_id !== journal.identity.session_id ||
      w.store_id !== journal.identity.store_id ||
      w.connection_id !== original.input['connection_id'] ||
      w.role !== original.input['role'] ||
      w.event_seq !== original.input['event_seq'] ||
      w.callback_hash !== createHash('sha256').update(Buffer.from(raw.data, 'hex')).digest('hex')
    )
      throw failure('FIX_LIVE_CALLBACK_UNRESOLVED');
  }
  verify();
  if (original.action === 'APPLY')
    return service.apply(binding, actor, original.input, key, verify);
  return service.command(binding, actor, original.action, original.input, key, verify);
}
