/** Independent SQL, one authorized consistent snapshot; no domain financial helpers. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { DomainError } from '../../domain/errors.js';
import type { Binding } from '../fixed-income-workflow/bindings.js';
import type { VerificationDatabase } from '../reconciliation/database.js';
import { verificationQueries, verificationSources } from '../reconciliation/manifest.js';
const SQL_HASH = '57a321744df05f3814e976a947dab52c44828161a3398abd65e81bac34613602';
const watermark = z.string().regex(/^[0-9]{1,4}$/);
const resultSchema = z
  .object({
    profile: z.literal('fix-application-v1'),
    physical_schema_revision: z.literal(7),
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
    new URL('../../../verification/sql/fix_application.sql', import.meta.url),
    'utf8',
  );
  if (createHash('sha256').update(sql).digest('hex') !== SQL_HASH)
    throw new DomainError(
      503,
      'VERIFICATION_SOURCE_CHANGED',
      'Application verifier source changed.',
    );
  const financial = await verificationQueries();
  return database.transaction(true, verify, async (db) => {
    const a = await db.query<{ allowed: boolean }>(
      'SELECT fi_control.fix_snapshot_access($1,$2,$3,$4) allowed',
      [binding.sandboxId, binding.digest, binding.scope, binding.generation],
    );
    if (!a.rows[0]?.allowed) throw new DomainError(404, 'SANDBOX_NOT_FOUND', 'Sandbox not found.');
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
    const r = resultSchema.parse((await db.query(sql, [binding.sandboxId])).rows[0]);
    const consistent = r.total_findings === 0 && financialFindings === 0,
      complete = consistent && r.unresolved_message_count === 0 && r.applied_work_count > 0;
    return {
      ...r,
      sql_hash: SQL_HASH,
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
