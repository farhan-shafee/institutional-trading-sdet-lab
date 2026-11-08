import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { DomainError } from '../app/domain/errors.js';
import { ownedSourceSchema } from '../app/domain/post-trade/source.js';
import { assessOwned } from '../app/domain/post-trade/assessment.js';
import {
  portfolioQuerySchema,
  postTradeHistorySchema,
  postTradeAuditEventSchema,
} from '../app/domain/post-trade/api-contracts.js';
import { workflowResultSchema } from '../app/domain/workflow/contracts.js';
import { PostTradeWorkflowDatabase } from '../app/persistence/postgres/post-trade-workflow.js';
import { verifyOwned } from './owned-postgres.js';
import { loadPrivate } from './private-state.js';

export const reportContextSchema = portfolioQuerySchema
  .extend({
    version: z.literal(1),
    owner_file: z.string().min(1).max(4096),
    sandbox_id: z.uuid(),
    proof: z.string().regex(/^[a-f0-9]{64}$/),
    scope: z.enum(['read', 'trade']),
    generation: ownedSourceSchema.shape.generation,
  })
  .strict();
const historySchema = postTradeHistorySchema.omit({ source: true });
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
/** One read-only repeatable snapshot, private owned descriptor and current capability proof. */
export async function buildPostTradeReport(input: unknown) {
  const context = reportContextSchema.parse(input),
    owner = await verifyOwned(context.owner_file);
  if (!owner.appUrl) throw new Error('Owned app role required.');
  const database = new PostTradeWorkflowDatabase(owner.appUrl);
  try {
    return await database.transaction(
      true,
      () => {},
      async (db) => {
        async function rpc(sql: string, params: unknown[]) {
          const result = workflowResultSchema.parse(
            (await db.query<{ result: unknown }>(sql, params)).rows[0]?.result,
          );
          if (result.status !== 200)
            throw new DomainError(
              result.status,
              'POSTTRADE_REPORT_UNAVAILABLE',
              'Owned report is unavailable.',
            );
          return result.body;
        }
        const auth = [context.sandbox_id, context.proof, context.scope, context.generation];
        const source = ownedSourceSchema.parse(
          await rpc('SELECT fi_control.read_posttrade($1,$2,$3,$4,$5,$6) result', [
            ...auth,
            context.raw_as_of_seq ?? null,
            context.posttrade_as_of_seq ?? null,
          ]),
        );
        if (source.sandbox_id !== context.sandbox_id || source.generation !== context.generation)
          throw new Error('Owned report source mismatch.');
        const history: z.infer<typeof historySchema>[] = [];
        for (const root of source.roots) {
          const full = historySchema.parse(
            await rpc('SELECT fi_control.read_posttrade_history($1,$2,$3,$4,$5) result', [
              ...auth,
              root.execution_id,
            ]),
          );
          if (full.original_execution.execution_id !== root.execution_id)
            throw new Error('Owned report root mismatch.');
          const before = (row: { posttrade_command_seq: string }) =>
            BigInt(row.posttrade_command_seq) <= BigInt(source.posttrade_command_seq);
          const revisions = full.revisions.filter(before);
          history.push({
            ...full,
            registered: revisions.length > 0,
            revisions,
            bust: full.bust && before(full.bust) ? full.bust : null,
            settlement_outcomes: full.settlement_outcomes.filter(before),
          });
        }
        const events: z.infer<typeof postTradeAuditEventSchema>[] = [];
        let after = '0',
          index = -1;
        for (let page = 0; page < 2; page++) {
          const rows = z
            .object({ events: z.array(postTradeAuditEventSchema).max(101) })
            .strict()
            .parse(
              await rpc('SELECT fi_control.read_posttrade_audit($1,$2,$3,$4,$5,$6,$7,$8) result', [
                ...auth,
                source.posttrade_command_seq,
                after,
                index,
                100,
              ]),
            ).events;
          events.push(...rows.slice(0, 100));
          if (rows.length <= 100) break;
          const last = events.at(-1);
          if (!last || page === 1) throw new Error('Owned report event bound.');
          after = last.command_seq;
          index = last.event_index;
        }
        if (events.length > 161) throw new Error('Owned report event bound.');
        const bundle = {
          version: 1 as const,
          kind: 'OWNED_POSTTRADE_REPORT_V1' as const,
          scope: 'LOCAL_SYNTHETIC_ONLY' as const,
          source,
          assessment: assessOwned(source, context.fixture_id, context.as_of_date),
          history,
          events,
        };
        const report = {
          ...bundle,
          report_id: createHash('sha256')
            .update(JSON.stringify(canonical(bundle)))
            .digest('hex'),
        };
        if (Buffer.byteLength(JSON.stringify(report), 'utf8') > 262144)
          throw new Error('Owned report byte bound.');
        return report;
      },
    );
  } finally {
    await database.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [path, ...extra] = process.argv.slice(2);
    if (!path || extra.length) throw new Error('One private owned report context is required.');
    const report = await buildPostTradeReport(await loadPrivate(path));
    process.stdout.write(JSON.stringify(report) + '\n');
  } catch {
    console.error(
      'Owned post-trade report failed; private connection and capability material omitted.',
    );
    process.exitCode = 1;
  }
}
