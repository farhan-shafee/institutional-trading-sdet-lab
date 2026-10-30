import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { DomainError } from '../../domain/errors.js';
import {
  parseWorkflow,
  sandboxBodySchema,
  workflowResultSchema,
  type Scope,
  type WorkflowResult,
} from '../../domain/workflow/contracts.js';
import type { WorkflowDatabase } from '../../persistence/postgres/workflow.js';
import type { Binding } from './bindings.js';

export function capabilityDigest(id: string, scope: Scope, capability: string): string {
  return createHash('sha256')
    .update(`tradeflow-recovery-v1:${id}:${scope}:${capability}`)
    .digest('hex');
}
function fingerprint(operation: string, id: string, payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify({ version: 1, method: 'POST', operation, sandbox_id: id, payload }))
    .digest('hex');
}
const cursorSchema = z
  .object({
    id: z.uuid(),
    upper: z.string().regex(/^\d{1,3}$/),
    after: z.string().regex(/^\d{1,3}$/),
    index: z.number().int().min(-1).max(2),
    limit: z.number().int().min(1).max(100),
    expires: z.number().finite(),
  })
  .strict();
const eventSchema = z
  .object({
    command_seq: z.string(),
    event_index: z.number().int(),
    event_type: z.enum([
      'SANDBOX_CREATED',
      'CAPABILITIES_ROTATED',
      'COMMAND_REJECTED',
      'RFQ_CREATED',
      'DEALER_RESPONDED',
      'DEALER_DECLINED',
      'QUOTE_PUBLISHED',
      'QUOTE_WITHDRAWN',
      'RFQ_EXPIRED',
      'QUOTE_ACCEPTED',
      'RFQ_ACCEPTED',
      'ORDER_CREATED',
      'ORDER_ACKNOWLEDGED',
      'ORDER_REJECTED',
      'EXECUTION_RECORDED',
      'ORDER_STATE_CHANGED',
      'POSITION_UPDATED',
      'EXECUTION_DUPLICATE',
      'CANCEL_REQUESTED',
      'CANCEL_ACKNOWLEDGED',
      'CANCEL_REJECTED',
    ]),
    aggregate_version: z.string().nullable(),
    actor_id: z.uuid(),
    actor_kind: z.literal('CLIENT'),
    decided_at: z.iso.datetime(),
    recorded_at: z.iso.datetime(),
    payload: z.record(z.string(), z.string()),
  })
  .strict();
const auditSchema = z
  .object({
    events: z.array(eventSchema).max(100),
    as_of_seq: z.string(),
    next_cursor: z.string().nullable(),
  })
  .strict();

export class WorkflowService {
  private readonly cursorSecret = randomBytes(32);
  constructor(readonly database: WorkflowDatabase) {}
  private async rpc(db: pg.PoolClient, sql: string, values: unknown[]): Promise<WorkflowResult> {
    const result = await db.query<{ result: unknown }>(sql, values);
    return workflowResultSchema.parse(result.rows[0]?.result);
  }
  async status(verify: () => void): Promise<{ enabled: true; state: 'ready' | 'unavailable' }> {
    try {
      await this.database.transaction(true, verify, () => Promise.resolve(undefined));
      return { enabled: true, state: 'ready' };
    } catch (error) {
      if (error instanceof DomainError && error.status !== 503) throw error;
      return { enabled: true, state: 'unavailable' };
    }
  }
  async create(
    input: { sandbox_id: string; read_capability: string; trade_capability: string },
    key: string,
    actor: string,
    verify: () => void,
  ) {
    const id = input.sandbox_id.toLowerCase();
    const read = capabilityDigest(id, 'read', input.read_capability),
      trade = capabilityDigest(id, 'trade', input.trade_capability);
    const hash = fingerprint('CREATE_SANDBOX', id, { read_digest: read, trade_digest: trade });
    const result = await this.database.transaction(false, verify, (db) =>
      this.rpc(db, 'SELECT fi_control.create_sandbox($1,$2,$3,$4,$5,$6) AS result', [
        id,
        read,
        trade,
        hash,
        key,
        actor,
      ]),
    );
    const binding =
      result.status === 201
        ? {
            sandboxId: id,
            digest: trade,
            scope: 'trade' as const,
            generation: sandboxBodySchema.parse(result.body).sandbox.generation,
          }
        : undefined;
    return { result, binding };
  }
  async recover(id: string, scope: Scope, capability: string, verify: () => void) {
    const digest = capabilityDigest(id, scope, capability);
    const result = await this.database.transaction(true, verify, (db) =>
      this.rpc(db, 'SELECT fi_control.read_sandbox($1,$2,$3) AS result', [id, digest, scope]),
    );
    const binding =
      result.status === 200
        ? {
            sandboxId: id,
            digest,
            scope,
            generation: sandboxBodySchema.parse(result.body).sandbox.generation,
          }
        : undefined;
    return { result, binding };
  }
  private async authorize(
    db: pg.PoolClient,
    binding: Binding,
  ): Promise<z.infer<typeof sandboxBodySchema>> {
    const result = await this.rpc(db, 'SELECT fi_control.read_sandbox($1,$2,$3) AS result', [
      binding.sandboxId,
      binding.digest,
      binding.scope,
    ]);
    if (result.status !== 200)
      throw new DomainError(404, 'SANDBOX_NOT_FOUND', 'Sandbox not found.');
    const body = sandboxBodySchema.parse(result.body);
    if (body.sandbox.generation !== binding.generation)
      throw new DomainError(404, 'SANDBOX_NOT_FOUND', 'Sandbox not found.');
    await db.query("SELECT set_config('tradeflow.sandbox_id',$1,true)", [binding.sandboxId]);
    return body;
  }
  async read(binding: Binding, verify: () => void): Promise<WorkflowResult> {
    const body = await this.database.transaction(true, verify, (db) => this.authorize(db, binding));
    return { status: 200, body, replayed: false };
  }
  async rotate(
    binding: Binding,
    input: { expected_generation: string; read_capability: string; trade_capability: string },
    key: string,
    actor: string,
    verify: () => void,
  ): Promise<WorkflowResult> {
    const read = capabilityDigest(binding.sandboxId, 'read', input.read_capability),
      trade = capabilityDigest(binding.sandboxId, 'trade', input.trade_capability);
    const hash = fingerprint('ROTATE_CAPABILITIES', binding.sandboxId, {
      expected_generation: input.expected_generation,
      read_digest: read,
      trade_digest: trade,
    });
    return this.database.transaction(false, verify, (db) =>
      this.rpc(db, 'SELECT fi_control.rotate_capabilities($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result', [
        binding.sandboxId,
        binding.digest,
        binding.generation,
        input.expected_generation,
        read,
        trade,
        hash,
        key,
        actor,
      ]),
    );
  }
  async command(binding: Binding, key: string, verify: () => void): Promise<WorkflowResult> {
    return this.database.transaction(true, verify, async (db) => {
      await this.authorize(db, binding);
      const result = await db.query<Record<string, unknown>>(
        `SELECT idempotency_key,operation,command_seq::text,http_status,result_kind,response_body,
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
        FROM fi.commands WHERE sandbox_id=$1 AND idempotency_key=$2`,
        [binding.sandboxId, key],
      );
      if (!result.rows[0])
        throw new DomainError(404, 'COMMAND_NOT_FOUND', 'Command receipt not found.');
      return { status: 200, body: { command: result.rows[0] }, replayed: false };
    });
  }
  async audit(
    binding: Binding,
    parameters: URLSearchParams,
    verify: () => void,
  ): Promise<WorkflowResult> {
    const query = Object.create(null) as Record<string, string>;
    for (const [key, value] of parameters) {
      if (Object.hasOwn(query, key))
        throw new DomainError(400, 'VALIDATION_ERROR', 'Duplicate query field.');
      query[key] = value;
    }
    const input = parseWorkflow(
      z
        .object({
          limit: z
            .string()
            .regex(/^(?:[1-9]|[1-9][0-9]|100)$/)
            .optional(),
          cursor: z.string().max(1024).optional(),
        })
        .strict(),
      query,
    );
    const cursor = input.cursor ? this.decodeCursor(input.cursor) : undefined;
    const limit = input.limit ? Number(input.limit) : (cursor?.limit ?? 50);
    if (cursor && (cursor.id !== binding.sandboxId || cursor.limit !== limit))
      throw new DomainError(400, 'VALIDATION_ERROR', 'Cursor scope mismatch.');
    return this.database.transaction(true, verify, async (db) => {
      const body = await this.authorize(db, binding);
      const upper = cursor?.upper ?? body.sandbox.commit_seq;
      const rows = await db.query<Record<string, unknown>>(
        `SELECT command_seq::text,event_index,event_type,aggregate_version::text,actor_id,actor_kind,
        to_char(decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided_at,
        to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at,payload
        FROM fi.audit_events WHERE sandbox_id=$1 AND (command_seq,event_index)>($2::bigint,$5::integer) AND command_seq<=$3::bigint
        ORDER BY command_seq,event_index LIMIT $4`,
        [binding.sandboxId, cursor?.after ?? '0', upper, limit + 1, cursor?.index ?? -1],
      );
      const events = rows.rows.slice(0, limit).map((row) => eventSchema.parse(row));
      const next =
        rows.rows.length > limit
          ? this.encodeCursor({
              id: binding.sandboxId,
              upper,
              after: events.at(-1)!.command_seq,
              index: events.at(-1)!.event_index,
              limit,
              expires: Date.now() + 300_000,
            })
          : null;
      return {
        status: 200,
        body: auditSchema.parse({ events, as_of_seq: upper, next_cursor: next }),
        replayed: false,
      };
    });
  }
  private encodeCursor(value: z.infer<typeof cursorSchema>): string {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${payload}.${createHmac('sha256', this.cursorSecret).update(payload).digest('base64url')}`;
  }
  private decodeCursor(value: string): z.infer<typeof cursorSchema> {
    const [payload, signature, ...extra] = value.split('.');
    const expected = createHmac('sha256', this.cursorSecret)
      .update(payload ?? '')
      .digest();
    const supplied = Buffer.from(signature ?? '', 'base64url');
    if (
      !payload ||
      extra.length ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new DomainError(409, 'CURSOR_EXPIRED', 'Restart the audit list.');
    let cursor: z.infer<typeof cursorSchema>;
    try {
      cursor = cursorSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    } catch {
      throw new DomainError(400, 'VALIDATION_ERROR', 'Invalid audit cursor.');
    }
    if (Date.now() >= cursor.expires)
      throw new DomainError(409, 'CURSOR_EXPIRED', 'Restart the audit list.');
    return cursor;
  }
}
