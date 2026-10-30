import type pg from 'pg';
import { DomainError } from '../../domain/errors.js';
import {
  findingSchema,
  verificationNames,
  reconciliationReportSchema,
  type Finding,
  type VerificationMetadata,
  type ReconciliationReport,
} from '../../domain/workflow/reconciliation.js';
import type { Binding } from '../fixed-income-workflow/bindings.js';
import type { VerificationDatabase } from './database.js';
import { verificationQueries } from './manifest.js';
export type ScanHooks = {
  afterSnapshot?: () => void | Promise<void>;
  beforeQuery?: (
    name: (typeof verificationNames)[number],
    client: pg.PoolClient,
  ) => void | Promise<void>;
};
export async function scanSnapshot(
  database: VerificationDatabase,
  binding: Binding,
  run: string,
  worker: string,
  metadata: VerificationMetadata,
  verify: () => void,
  hooks: ScanHooks = {},
): Promise<ReconciliationReport> {
  const report: ReconciliationReport = {
    status: 'FAILED',
    snapshot: null,
    coverage: verificationNames.map((name) => ({
      name,
      hash: metadata.query_hashes[name],
      status: 'NOT_RUN',
      rows: 0,
    })),
    findings: [],
    total_findings: 0,
    failure_reason: 'SQL_FAILURE',
  };
  let active = -1;
  const candidates: Finding[] = [];
  try {
    const queries = await verificationQueries();
    await database.transaction(true, verify, async (client) => {
      await client.query("SELECT set_config('tradeflow.sandbox_id',$1,true)", [binding.sandboxId]);
      const context = await client.query<{
        allowed: boolean;
        id: string;
        at: Date;
        watermark: string;
      }>(
        'SELECT fi_control.reconciliation_snapshot_access($1,$2,$3,$4,$5) AS allowed,pg_current_snapshot()::text AS id,clock_timestamp() AS at,(SELECT COALESCE(max(command_seq),0)::text FROM fi.commands WHERE sandbox_id=$1) AS watermark',
        [binding.sandboxId, binding.digest, binding.generation, run, worker],
      );
      const row = context.rows[0];
      if (!row?.allowed)
        throw new DomainError(404, 'SANDBOX_NOT_FOUND', 'Authorized reconciliation run not found.');
      report.snapshot = { id: row.id, at: row.at.toISOString(), watermark: row.watermark };
      await hooks.afterSnapshot?.();
      for (const [index, name] of verificationNames.entries()) {
        active = index;
        verify();
        await hooks.beforeQuery?.(name, client);
        const sql =
          name === 'comparisons'
            ? `SELECT *,count(*) OVER()::integer AS __total FROM (${queries[name]}) checks ORDER BY category,code,record_kind,record_id,expected::text,observed::text LIMIT 129`
            : `SELECT *,count(*) OVER()::integer AS __total FROM (${queries[name]}) checks WHERE sandbox_id=$1 ORDER BY invariant,to_jsonb(checks)::text LIMIT 129`;
        const result = await client.query<Record<string, unknown>>(sql, [binding.sandboxId]);
        const total = result.rows.length ? Number(result.rows[0]!.__total) : 0;
        if (!Number.isSafeInteger(total) || total < 0 || total > 100000)
          throw new Error('Verification row bound exceeded.');
        report.coverage[index]!.rows = total;
        report.total_findings += total;
        for (const raw of result.rows) {
          const { __total: ignored, ...value } = raw;
          void ignored;
          if (name === 'comparisons') candidates.push(findingSchema.parse(value));
          else {
            if (value.sandbox_id !== binding.sandboxId)
              throw new Error('Cross-sandbox verification output.');
            const id =
              typeof value.order_id === 'string'
                ? value.order_id
                : typeof value.rfq_id === 'string'
                  ? value.rfq_id
                  : binding.sandboxId;
            const kind =
              typeof value.order_id === 'string'
                ? 'ORDER'
                : typeof value.rfq_id === 'string'
                  ? 'RFQ'
                  : 'SANDBOX';
            candidates.push(
              findingSchema.parse({
                category:
                  name === 'foundation'
                    ? 'FOUNDATION'
                    : name === 'rfq'
                      ? 'RFQ_CONTRACT'
                      : 'REFERENCE',
                code: value.invariant,
                record_kind: kind,
                record_id: id,
                related:
                  kind === 'ORDER'
                    ? { order_id: id }
                    : kind === 'RFQ'
                      ? { rfq_id: id }
                      : { sandbox_id: id },
                expected: { violations: '0' },
                observed: { violations: '1', source_check: name, evidence: JSON.stringify(value) },
              }),
            );
          }
        }
        report.coverage[index]!.status = 'COMPLETE';
        active = -1;
      }
    });
    report.status =
      report.total_findings > 128
        ? 'INCOMPLETE'
        : report.total_findings
          ? 'COMPLETED_WITH_FINDINGS'
          : 'COMPLETED_CLEAN';
    report.failure_reason = report.status === 'INCOMPLETE' ? 'FINDING_LIMIT' : null;
  } catch (error) {
    if (error instanceof DomainError && [401, 403, 404].includes(error.status)) throw error;
    if (active >= 0) report.coverage[active]!.status = 'FAILED';
    report.status = 'FAILED';
    report.failure_reason =
      error instanceof DomainError && error.code === 'VERIFICATION_TIMEOUT'
        ? 'VERIFICATION_TIMEOUT'
        : error instanceof DomainError && error.code === 'RECONCILER_UNAVAILABLE'
          ? 'DATABASE_UNAVAILABLE'
          : 'SQL_FAILURE';
  }
  report.findings = candidates
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'))
    .slice(0, 128);
  return reconciliationReportSchema.parse(report);
}
