/** Independent SQL, one authorized consistent snapshot; no domain financial helpers. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { DomainError } from '../../domain/errors.js';
import type { Binding } from '../fixed-income-workflow/bindings.js';
import type { VerificationDatabase } from '../reconciliation/database.js';
import { verificationQueries, verificationSources } from '../reconciliation/manifest.js';
import { loadFoundationVerificationSource } from './reconciliation.js';
const SQL_HASH = '169fda4ea6ec828721fe551b3843daf802870ecf82839453d10dcc10a7979211';
const watermark = z.string().regex(/^[0-9]{1,4}$/);
const resultSchema = z
  .object({
    profile: z.literal('fix-application-v2'),
    physical_schema_revision: z.literal(8),
    snapshot_id: z.string().max(4096),
    snapshot_at: z.date(),
    financial_watermark: watermark,
    protocol_watermark: watermark,
    protocol_ingest_watermark: watermark,
    protocol_prepare_watermark: watermark,
    protocol_application_watermark: watermark,
    applied_work_count: z.number().int().min(0).max(100),
    unresolved_message_count: z.number().int().min(0).max(160),
    delivery_verified: z.literal(false),
    external_completeness_verified: z.literal(false),
    findings: z
      .array(
        z
          .object({ code: z.string().regex(/^[A-Z_]{2,64}$/), record_id: z.string().max(128) })
          .strict(),
      )
      .max(128),
    total_findings: z.number().int().min(0).max(100000),
  })
  .strict();
export async function verifyFixApplication(
  database: VerificationDatabase,
  binding: Binding,
  verify: () => void,
  enabled = false,
) {
  if (!enabled)
    throw new DomainError(503, 'FIX_APPLICATION_DISABLED', 'FIX application is disabled.');
  const sql = await readFile(
    new URL('../../../verification/sql/fix_application_v2.sql', import.meta.url),
    'utf8',
  );
  if (createHash('sha256').update(sql).digest('hex') !== SQL_HASH)
    throw new DomainError(
      503,
      'VERIFICATION_SOURCE_CHANGED',
      'Application verifier source changed.',
    );
  const foundation = await loadFoundationVerificationSource();
  const financial = await verificationQueries();
  return database.transaction(true, verify, async (db) => {
    const a = await db.query<{ allowed: boolean }>(
      'SELECT fi_control.fix_snapshot_access($1,$2,$3,$4) allowed',
      [binding.sandboxId, binding.digest, binding.scope, binding.generation],
    );
    if (!a.rows[0]?.allowed) throw new DomainError(404, 'SANDBOX_NOT_FOUND', 'Sandbox not found.');
    const foundationReport = foundation.parse(
      (await db.query(foundation.sql, [binding.sandboxId])).rows[0],
    );
    const r = resultSchema.parse((await db.query(sql, [binding.sandboxId])).rows[0]);
    if (
      foundationReport.snapshot_id !== r.snapshot_id ||
      foundationReport.financial_watermark !== r.financial_watermark ||
      foundationReport.protocol_watermark !== r.protocol_watermark ||
      foundationReport.protocol_ingest_watermark !== r.protocol_ingest_watermark ||
      foundationReport.protocol_prepare_watermark !== r.protocol_prepare_watermark
    )
      throw new DomainError(
        503,
        'RECONCILIATION_SQL_FAILURE',
        'Verification layers do not describe one consistent snapshot.',
      );
    const coverage = [];
    let financialFindings = 0;
    for (const [name, query] of Object.entries(financial)) {
      const r = await db.query<Record<string, unknown>>(
        name === 'comparisons' ? query : `SELECT * FROM (${query}) v WHERE sandbox_id=$1`,
        [binding.sandboxId],
      );
      financialFindings += r.rows.length;
      coverage.push({
        name,
        hash: verificationSources[name as keyof typeof verificationSources].hash,
        findings: r.rows.length,
      });
    }
    const consistent =
        foundationReport.total_findings === 0 && r.total_findings === 0 && financialFindings === 0,
      complete = consistent && r.unresolved_message_count === 0 && r.applied_work_count > 0;
    return {
      ...r,
      sql_hash: SQL_HASH,
      foundation_coverage: { ...foundationReport, sql_hash: foundation.source.sha256 },
      financial_coverage: coverage,
      financial_findings: financialFindings,
      financial_ledger_consistency: financialFindings === 0 ? 'CONSISTENT' : 'FINDINGS',
      assessment: !consistent
        ? 'APPLICATION_FINDINGS'
        : complete
          ? 'OBSERVED_APPLICATION_CONSISTENT'
          : 'INCOMPLETE',
      observed_transcript_complete: complete,
      financial_application_verified: complete,
      verified_scope: 'OBSERVED_PROTOCOL_AND_LEDGER',
      protocol_completeness: 'OBSERVED_MESSAGES_ONLY',
    };
  });
}
