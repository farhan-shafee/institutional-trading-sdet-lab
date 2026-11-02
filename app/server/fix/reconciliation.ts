import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DomainError } from '../../domain/errors.js';
import type { Binding } from '../fixed-income-workflow/bindings.js';
import type { VerificationDatabase } from '../reconciliation/database.js';
const watermark = z.string().regex(/^[0-9]{1,4}$/);
const reportSchema = z
  .object({
    profile: z.literal('fix-foundation-v1'),
    physical_schema_revision: z.literal(6),
    snapshot_id: z
      .string()
      .regex(/^[0-9]+:[0-9]+:[0-9,]*$/)
      .max(4096),
    snapshot_at: z.date(),
    financial_watermark: watermark,
    protocol_watermark: watermark,
    protocol_ingest_watermark: watermark,
    protocol_prepare_watermark: watermark,
    protocol_application_watermark: z.literal('0'),
    unresolved_work_count: z.number().int().min(0).max(160),
    financial_ledger_consistency: z.literal('NOT_EVALUATED'),
    protocol_completeness: z.literal('NOT_IMPLEMENTED'),
    delivery_verified: z.literal(false),
    financial_application_verified: z.literal(false),
    foundation_assessment: z.enum(['FOUNDATION_CONSISTENT', 'FOUNDATION_FINDINGS']),
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
export async function verifyFixFoundation(
  database: VerificationDatabase,
  binding: Binding,
  verify: () => void,
  enabled = false,
) {
  if (!enabled)
    throw new DomainError(503, 'FIX_FOUNDATION_DISABLED', 'FIX foundation is disabled.');
  const sql = await readFile(
    new URL('../../../verification/sql/fix_foundation.sql', import.meta.url),
    'utf8',
  );
  if (
    createHash('sha256').update(sql).digest('hex') !==
    '6d7141817bb414de9ed957ee4c32c55112620f4bf786a182f2e253d5ac008b73'
  )
    throw new DomainError(503, 'VERIFICATION_SOURCE_CHANGED', 'Protocol verifier source changed.');
  return database.transaction(true, verify, async (db) => {
    const a = await db.query<{ allowed: boolean }>(
      'SELECT fi_control.fix_snapshot_access($1,$2,$3,$4) AS allowed',
      [binding.sandboxId, binding.digest, binding.scope, binding.generation],
    );
    if (!a.rows[0]?.allowed) throw new DomainError(404, 'SANDBOX_NOT_FOUND', 'Sandbox not found.');
    const r = await db.query<Record<string, unknown>>(sql, [binding.sandboxId]);
    return {
      ...reportSchema.parse(r.rows[0]),
      complete: false,
      verified_scope: 'PROTOCOL_METADATA_ONLY',
    };
  });
}
