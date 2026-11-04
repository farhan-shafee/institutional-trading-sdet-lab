import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DomainError } from '../../domain/errors.js';
import type { Binding } from '../fixed-income-workflow/bindings.js';
import type { VerificationDatabase } from '../reconciliation/database.js';
// Historical source is immutable provenance, never a fallback for schema8.
// VerificationDatabase independently requires the exact current migration inventory.
export const foundationVerificationSources = {
  historical: {
    file: 'fix_foundation.sql',
    sha256: '6d7141817bb414de9ed957ee4c32c55112620f4bf786a182f2e253d5ac008b73',
    profile: 'fix-foundation-v1',
    schema: 6,
  },
  current: {
    file: 'fix_foundation_v2.sql',
    sha256: '076e401fa696f81c1b733dc718b0eab21114914cf10685bbe53cc4b0e69566cd',
    profile: 'fix-foundation-v2',
    schema: 8,
  },
} as const;

async function pinnedSource(source: { readonly file: string; readonly sha256: string }) {
  const sql = await readFile(
    new URL('../../../verification/sql/' + source.file, import.meta.url),
    'utf8',
  );
  if (createHash('sha256').update(sql).digest('hex') !== source.sha256)
    throw new DomainError(503, 'VERIFICATION_SOURCE_CHANGED', 'Protocol verifier source changed.');
  return sql;
}

const watermark = z.string().regex(/^[0-9]{1,4}$/);
const reportSchema = z
  .object({
    profile: z.literal(foundationVerificationSources.current.profile),
    physical_schema_revision: z.literal(foundationVerificationSources.current.schema),
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
/** Shared pinned SQL/parser only; callers retain their own authorization and transaction. */
export async function loadFoundationVerificationSource() {
  await pinnedSource(foundationVerificationSources.historical);
  return {
    sql: await pinnedSource(foundationVerificationSources.current),
    source: foundationVerificationSources.current,
    parse: (record: unknown) => reportSchema.parse(record),
  };
}
export async function verifyFixFoundation(
  database: VerificationDatabase,
  binding: Binding,
  verify: () => void,
  enabled = false,
) {
  if (!enabled)
    throw new DomainError(503, 'FIX_FOUNDATION_DISABLED', 'FIX foundation is disabled.');
  const foundation = await loadFoundationVerificationSource();
  return database.transaction(true, verify, async (db) => {
    const a = await db.query<{ allowed: boolean }>(
      'SELECT fi_control.fix_snapshot_access($1,$2,$3,$4) AS allowed',
      [binding.sandboxId, binding.digest, binding.scope, binding.generation],
    );
    if (!a.rows[0]?.allowed) throw new DomainError(404, 'SANDBOX_NOT_FOUND', 'Sandbox not found.');
    const r = await db.query<Record<string, unknown>>(foundation.sql, [binding.sandboxId]);
    return {
      ...foundation.parse(r.rows[0]),
      complete: false,
      verified_scope: 'PROTOCOL_METADATA_ONLY',
    };
  });
}
