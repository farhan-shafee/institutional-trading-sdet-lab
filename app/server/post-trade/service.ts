import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { DomainError } from '../../domain/errors.js';
import { workflowResultSchema, type WorkflowResult } from '../../domain/workflow/contracts.js';
import { ownedSourceSchema, type OwnedPostTradeSnapshot } from '../../domain/post-trade/source.js';
import { assessOwned, ownedSourceIdentity } from '../../domain/post-trade/assessment.js';
import {
  postTradeMutationSchemas,
  postTradeFailureBodySchema,
  postTradeErrorSchema,
  commandReceiptSchema,
  type postTradeSourceQuerySchema,
  type portfolioQuerySchema,
  type postTradeAuditQuerySchema,
  riskAssessmentSchema,
  pnlAssessmentSchema,
  postTradeHistorySchema,
  postTradeAuditEventSchema,
  postTradeAuditSchema,
  type PostTradeOperation,
} from '../../domain/post-trade/api-contracts.js';
import type { PostTradeWorkflowDatabase } from '../../persistence/postgres/post-trade-workflow.js';
import type { Binding } from '../fixed-income-workflow/bindings.js';

const cursorSchema = z
  .object({
    id: z.uuid(),
    generation: z.string().regex(/^[1-9][0-9]{0,9}$/),
    raw: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,2})$/)
      .refine((value) => BigInt(value) <= 512n),
    upper: z
      .string()
      .regex(/^(0|[1-9][0-9]?)$/)
      .refine((value) => BigInt(value) <= 97n),
    after: z
      .string()
      .regex(/^(0|[1-9][0-9]?)$/)
      .refine((value) => BigInt(value) <= 97n),
    index: z.number().int().min(-1).max(1),
    limit: z.number().int().min(1).max(100),
    expires: z.number().finite(),
  })
  .strict();
type Cursor = z.infer<typeof cursorSchema>;
export class PostTradeService {
  private readonly cursorSecret = randomBytes(32);
  constructor(readonly database: PostTradeWorkflowDatabase) {}
  private async rpc(db: pg.PoolClient, sql: string, values: unknown[]): Promise<WorkflowResult> {
    const query = await db.query<{ result: unknown }>(sql, values);
    const result = workflowResultSchema.parse(query.rows[0]?.result);
    if (
      result.status !== 200 &&
      result.status !== 201 &&
      !(
        result.status === 409 &&
        typeof result.body === 'object' &&
        result.body !== null &&
        'settlement_state' in result.body
      )
    )
      result.body = postTradeErrorSchema.parse(result.body);
    return result;
  }
  private owned(body: unknown, binding: Binding): OwnedPostTradeSnapshot {
    const source = ownedSourceSchema.parse(body);
    if (source.sandbox_id !== binding.sandboxId || source.generation !== binding.generation)
      throw new DomainError(
        503,
        'SCHEMA_INCOMPATIBLE',
        'Owned post-trade source scope is incompatible.',
      );
    return source;
  }
  private async readSource(
    db: pg.PoolClient,
    binding: Binding,
    raw: string | null = null,
    post: string | null = null,
  ): Promise<WorkflowResult> {
    const result = await this.rpc(
      db,
      'SELECT fi_control.read_posttrade($1,$2,$3,$4,$5,$6) result',
      [binding.sandboxId, binding.digest, binding.scope, binding.generation, raw, post],
    );
    if (result.status === 200) result.body = this.owned(result.body, binding);
    return result;
  }
  async command(
    binding: Binding,
    operation: PostTradeOperation,
    payload: unknown,
    key: string,
    actor: string,
    verify: () => void,
  ): Promise<WorkflowResult> {
    return this.database.transaction(false, verify, async (db) => {
      const result = await this.rpc(
        db,
        'SELECT fi_control.posttrade_command($1,$2,$3,$4,$5,$6,$7) result',
        [
          binding.sandboxId,
          binding.digest,
          binding.generation,
          operation,
          JSON.stringify(payload),
          key,
          actor,
        ],
      );
      if (result.status === 200 || result.status === 201) {
        const expected = operation === 'SETTLE' || operation === 'REVERSE' ? 200 : 201;
        if (result.status !== expected)
          throw new DomainError(
            503,
            'SCHEMA_INCOMPATIBLE',
            'Owned mutation status is incompatible.',
          );
        result.body = postTradeMutationSchemas[operation].parse(result.body);
      } else if (
        operation === 'SETTLE' &&
        result.status === 409 &&
        typeof result.body === 'object' &&
        result.body !== null &&
        'settlement_state' in result.body
      )
        result.body = postTradeFailureBodySchema.parse(result.body);
      else result.body = postTradeErrorSchema.parse(result.body);
      return result;
    });
  }
  async source(
    binding: Binding,
    input: z.infer<typeof postTradeSourceQuerySchema>,
    verify: () => void,
  ): Promise<WorkflowResult> {
    return this.database.transaction(true, verify, (db) =>
      this.readSource(db, binding, input.raw_as_of_seq ?? null, input.posttrade_as_of_seq ?? null),
    );
  }
  async assessment(
    binding: Binding,
    input: z.infer<typeof portfolioQuerySchema>,
    kind: 'risk' | 'pnl',
    verify: () => void,
  ): Promise<WorkflowResult> {
    return this.database.transaction(true, verify, async (db) => {
      const result = await this.readSource(
        db,
        binding,
        input.raw_as_of_seq ?? null,
        input.posttrade_as_of_seq ?? null,
      );
      if (result.status !== 200) return result;
      const assessment = assessOwned(
        this.owned(result.body, binding),
        input.fixture_id,
        input.as_of_date,
      );
      let body: unknown = assessment;
      if (assessment.status === 'AVAILABLE') {
        const { risk, pnl, ...common } = assessment;
        body = kind === 'risk' ? { ...common, risk } : { ...common, pnl };
      }
      return {
        status: 200,
        replayed: false,
        body: (kind === 'risk' ? riskAssessmentSchema : pnlAssessmentSchema).parse(body),
      };
    });
  }
  async receipt(binding: Binding, key: string, verify: () => void): Promise<WorkflowResult> {
    return this.database.transaction(true, verify, async (db) => {
      const result = await this.rpc(
        db,
        'SELECT fi_control.read_posttrade_command($1,$2,$3,$4,$5) result',
        [binding.sandboxId, binding.digest, binding.scope, binding.generation, key],
      );
      if (result.status === 200) {
        const body = commandReceiptSchema.parse(result.body),
          command = body.command;
        if (command.http_status === 409) postTradeFailureBodySchema.parse(command.response_body);
        else postTradeMutationSchemas[command.operation].parse(command.response_body);
        if (command.idempotency_key !== key)
          throw new DomainError(503, 'SCHEMA_INCOMPATIBLE', 'Owned receipt scope is incompatible.');
        result.body = body;
      }
      return result;
    });
  }
  async history(binding: Binding, execution: string, verify: () => void): Promise<WorkflowResult> {
    return this.database.transaction(true, verify, async (db) => {
      const sourceResult = await this.readSource(db, binding);
      if (sourceResult.status !== 200) return sourceResult;
      const result = await this.rpc(
        db,
        'SELECT fi_control.read_posttrade_history($1,$2,$3,$4,$5) result',
        [binding.sandboxId, binding.digest, binding.scope, binding.generation, execution],
      );
      if (result.status === 200) {
        const part = postTradeHistorySchema.omit({ source: true }).parse(result.body);
        if (part.original_execution.execution_id !== execution)
          throw new DomainError(503, 'SCHEMA_INCOMPATIBLE', 'Owned root scope is incompatible.');
        result.body = postTradeHistorySchema.parse({
          ...part,
          source: ownedSourceIdentity(this.owned(sourceResult.body, binding)),
        });
      }
      return result;
    });
  }
  async audit(
    binding: Binding,
    input: z.infer<typeof postTradeAuditQuerySchema>,
    verify: () => void,
  ): Promise<WorkflowResult> {
    const cursor = input.cursor ? this.decode(input.cursor) : undefined;
    const limit = input.limit ? Number(input.limit) : (cursor?.limit ?? 50);
    if (
      cursor &&
      (cursor.id !== binding.sandboxId ||
        cursor.generation !== binding.generation ||
        cursor.limit !== limit)
    )
      throw new DomainError(409, 'CURSOR_EXPIRED', 'Restart the owned audit list.');
    return this.database.transaction(true, verify, async (db) => {
      const sourceResult = await this.readSource(
        db,
        binding,
        cursor?.raw ?? null,
        cursor?.upper ?? null,
      );
      if (sourceResult.status !== 200) return sourceResult;
      const source = this.owned(sourceResult.body, binding),
        upper = cursor?.upper ?? source.posttrade_command_seq;
      const result = await this.rpc(
        db,
        'SELECT fi_control.read_posttrade_audit($1,$2,$3,$4,$5,$6,$7,$8) result',
        [
          binding.sandboxId,
          binding.digest,
          binding.scope,
          binding.generation,
          upper,
          cursor?.after ?? '0',
          cursor?.index ?? -1,
          limit,
        ],
      );
      if (result.status !== 200) return result;
      const rows = z
        .object({ events: z.array(postTradeAuditEventSchema).max(101) })
        .strict()
        .parse(result.body).events;
      const events = rows.slice(0, limit),
        last = events.at(-1);
      const next =
        rows.length > limit && last
          ? this.encode({
              id: binding.sandboxId,
              generation: binding.generation,
              raw: cursor?.raw ?? source.raw_command_seq,
              upper,
              after: last.command_seq,
              index: last.event_index,
              limit,
              expires: Date.now() + 300000,
            })
          : null;
      return {
        status: 200,
        replayed: false,
        body: postTradeAuditSchema.parse({
          source: ownedSourceIdentity(source),
          events,
          as_of_seq: upper,
          next_cursor: next,
        }),
      };
    });
  }
  private encode(value: Cursor): string {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    return (
      payload + '.' + createHmac('sha256', this.cursorSecret).update(payload).digest('base64url')
    );
  }
  private decode(value: string): Cursor {
    const [payload, signature, ...extra] = value.split('.');
    const expected = createHmac('sha256', this.cursorSecret)
        .update(payload ?? '')
        .digest(),
      actual = Buffer.from(signature ?? '', 'base64url');
    if (
      !payload ||
      extra.length ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw new DomainError(409, 'CURSOR_EXPIRED', 'Restart the owned audit list.');
    let cursor: Cursor;
    try {
      cursor = cursorSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    } catch {
      throw new DomainError(400, 'VALIDATION_ERROR', 'Invalid audit cursor.');
    }
    if (Date.now() >= cursor.expires)
      throw new DomainError(409, 'CURSOR_EXPIRED', 'Restart the owned audit list.');
    return cursor;
  }
}
