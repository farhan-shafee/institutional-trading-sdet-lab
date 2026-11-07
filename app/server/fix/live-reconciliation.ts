/** Explicit schema9 snapshot, pinned independent SQL and standard-library oracle. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../../domain/errors.js';
import { financialSource } from '../../domain/workflow/database-contract.js';
import { liveMigrationChecksums } from '../../domain/workflow/live-database-contract.js';
import type { Binding } from '../fixed-income-workflow/bindings.js';
import { verificationQueries, verificationSources } from '../reconciliation/manifest.js';
import type { LiveVerificationDatabase } from './live-verification-database.js';
import type { LiveJournal } from './live-journal.js';
import { liveVerificationSources } from './live-verification-sources.js';

const finding = z
  .object({ code: z.string().regex(/^[A-Z_]{2,64}$/), record_id: z.string().max(128) })
  .strict();
const count = z.number().int().min(0).max(100000);
const watermark = z.string().regex(/^[0-9]{1,4}$/);
const sqlReport = z
  .object({
    profile: z.literal('fix-live-application-v1'),
    physical_schema_revision: z.literal(9),
    snapshot_id: z.string().max(4096),
    snapshot_at: z.date(),
    financial_watermark: watermark,
    protocol_watermark: watermark,
    protocol_ingest_watermark: watermark,
    protocol_prepare_watermark: watermark,
    protocol_application_watermark: watermark,
    applied_work_count: count,
    unresolved_message_count: count,
    live_callbacks: count,
    live_observations: count,
    live_applications: count,
    live_unresolved_observations: count,
    live_observation_watermark: watermark,
    live_acceptance_watermark: watermark,
    runtime_connection_watermark: count,
    delivery_verified: z.literal(false),
    external_completeness_verified: z.literal(false),
    findings: z.array(finding).max(128),
    total_findings: count,
  })
  .strict();
const oracleReport = z
  .object({
    findings: z.array(finding).max(128),
    total_findings: count,
    executions: count,
    cash_cents: z.string().regex(/^(0|[1-9][0-9]{0,30})$/),
    unresolved: count,
    financial_application_verified: z.boolean(),
  })
  .strict();
function failure(code: string) {
  return new DomainError(
    503,
    code,
    'Independent live verification did not complete. Retain the original evidence.',
  );
}
const digest = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex');
async function journalSnapshot(journal: LiveJournal) {
  const [request, frame, work] = await Promise.all([
    journal.entries('request'),
    journal.entries('frame'),
    journal.entries('work'),
  ]);
  return { identity: journal.identity, request, frame, work };
}

async function oracle(input: string, timeout: number): Promise<z.infer<typeof oracleReport>> {
  if (Buffer.byteLength(input) > 67108864 || timeout <= 0) throw failure('LIVE_ORACLE_BOUND');
  return new Promise((yes, no) => {
    const child = spawn(
      process.env['PYTHON'] ?? 'python3',
      [resolve('verification/python/fix_live_application.py')],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          LANG: 'C.UTF-8',
          PYTHONDONTWRITEBYTECODE: '1',
        },
      },
    );
    let output = Buffer.alloc(0),
      errors = 0,
      settled = false;
    const timer = setTimeout(() => finish(failure('LIVE_ORACLE_TIMEOUT')), timeout);
    function finish(error?: DomainError) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill('SIGKILL');
        no(error);
        return;
      }
      try {
        yes(oracleReport.parse(JSON.parse(output.toString('utf8')) as unknown));
      } catch {
        no(failure('LIVE_ORACLE_RESULT'));
      }
    }
    child.on('error', () => finish(failure('LIVE_ORACLE_UNAVAILABLE')));
    child.stdin.on('error', () => finish(failure('LIVE_ORACLE_PIPE')));
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length + chunk.length > 65536) finish(failure('LIVE_ORACLE_OUTPUT_BOUND'));
      else output = Buffer.concat([output, chunk]);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errors += chunk.length;
      if (errors > 4096) finish(failure('LIVE_ORACLE_OUTPUT_BOUND'));
    });
    child.on('close', (code) => finish(code === 0 ? undefined : failure('LIVE_ORACLE_FAILURE')));
    child.stdin.end(input);
  });
}

export async function verifyLiveApplication(
  database: LiveVerificationDatabase,
  binding: Binding,
  journal: LiveJournal,
  verify: () => void,
  enabled = false,
) {
  if (!enabled) throw failure('FIX_LIVE_VERIFICATION_DISABLED');
  verify();
  const sources = await Promise.all(
    Object.entries(liveVerificationSources).map(async ([file, hash]) => {
      const bytes = await readFile(resolve(file));
      if (digest(bytes) !== hash) throw failure('VERIFICATION_SOURCE_CHANGED');
      return [file, bytes] as const;
    }),
  );
  const source = new Map(sources),
    financial = await verificationQueries(),
    retained = await journalSnapshot(journal),
    journalHash = digest(JSON.stringify(retained));
  return database.transaction(true, verify, async (db) => {
    const deadline = performance.now() + 5000;
    const access = await db.query<{ allowed: boolean }>(
      'SELECT fi_control.fix_snapshot_access($1,$2,$3,$4) allowed',
      [binding.sandboxId, binding.digest, binding.scope, binding.generation],
    );
    if (!access.rows[0]?.allowed)
      throw new DomainError(404, 'SANDBOX_NOT_FOUND', 'Sandbox not found.');
    const sql = source.get('verification/sql/fix_live_application_v1.sql'),
      evidenceSql = source.get('verification/sql/fix_live_evidence_v1.sql');
    if (!sql || !evidenceSql) throw failure('VERIFICATION_SOURCE_CHANGED');
    const report = sqlReport.parse(
      (await db.query(sql.toString('utf8'), [binding.sandboxId])).rows[0],
    );
    const evidence = z
      .object({
        profile: z.literal('fix-live-evidence-v1'),
        physical_schema_revision: z.literal(9),
        snapshot_id: z.literal(report.snapshot_id),
        sandbox_id: z.literal(binding.sandboxId),
      })
      .passthrough()
      .parse((await db.query(evidenceSql.toString('utf8'), [binding.sandboxId])).rows[0]);
    const coverage = [];
    let financialFindings = 0;
    for (const [name, query] of Object.entries(financial)) {
      const rows = await db.query(
        name === 'comparisons' ? query : `SELECT * FROM (${query}) v WHERE sandbox_id=$1`,
        [binding.sandboxId],
      );
      financialFindings += rows.rows.length;
      coverage.push({
        name,
        sha256: verificationSources[name as keyof typeof verificationSources].hash,
        findings: rows.rows.length,
      });
    }
    const result = await oracle(
      JSON.stringify({ snapshot: evidence, journal: retained }),
      Math.min(2000, Math.floor(deadline - performance.now())),
    );
    verify();
    if (journalHash !== digest(JSON.stringify(await journalSnapshot(journal))))
      throw failure('LIVE_SNAPSHOT_CHANGED');
    const extra = coverage
      .filter((c) => c.findings > 0)
      .map((c) => ({ code: 'FINANCIAL_LEDGER', record_id: c.name }));
    const findings = [...report.findings, ...result.findings, ...extra]
      .sort((a, b) => a.code.localeCompare(b.code) || a.record_id.localeCompare(b.record_id))
      .slice(0, 128);
    const totalFindings = report.total_findings + result.total_findings + financialFindings;
    const complete =
      totalFindings === 0 &&
      report.unresolved_message_count === 0 &&
      report.live_unresolved_observations === 0 &&
      report.live_observations > 0 &&
      report.live_applications > 0 &&
      result.financial_application_verified;
    const finalReport = {
      ...report,
      findings,
      total_findings: totalFindings,
      oracle: result,
      financial_coverage: coverage,
      financial_findings: financialFindings,
      source_hashes: liveVerificationSources,
      schema_checksums: liveMigrationChecksums,
      financial_source: financialSource,
      journal_sha256: journalHash,
      snapshot_sha256: digest(JSON.stringify(evidence)),
      assessment:
        totalFindings > 0
          ? ('LIVE_APPLICATION_FINDINGS' as const)
          : complete
            ? ('OBSERVED_LIVE_APPLICATION_CONSISTENT' as const)
            : ('INCOMPLETE' as const),
      financial_application_verified: complete,
      protocol_scope: 'LIVE_BINDINGS_ONLY' as const,
      financial_scope: 'AUTHORIZED_SANDBOX_LEDGER' as const,
      callback_provenance: 'TRUSTED_LOCAL_CONTROLLER' as const,
      external_delivery_verified: false as const,
      external_completeness_verified: false as const,
    };
    //512KiB of the host8MiB partition is reserved for oracle/report/inspection output.
    if (Buffer.byteLength(JSON.stringify(finalReport)) > 196608)
      throw failure('LIVE_VERIFICATION_OUTPUT_BOUND');
    return finalReport;
  });
}
