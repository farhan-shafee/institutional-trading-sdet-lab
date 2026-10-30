import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { executionSandbox } from './execution-fixture.js';
import { connection } from './harness.js';
import { digest } from './rfq-fixture.js';
export const manifest = {
  engine_version: 'reconciliation-v1',
  source_revision: '0efa3fdf265d374af2756c98d24936b157849464',
  source_tree: 'f43762d715bfe3bee647b486d5cba1a4a194f6cc',
  source_state: 'CLEAN',
  schema_revision: 5,
  financial_source: '6016fb700840d081fe1fba651c918f0a7e709383',
  valuation_model: 'phase1-regular-coupon-v1',
  quotation_model: 'synthetic-dealer-grid-v1',
  conventions: ['ACT_ACT_ICMA', 'THIRTY_360_US'],
  query_hashes: {
    foundation: 'a'.repeat(64),
    rfq: 'b'.repeat(64),
    executions: 'c'.repeat(64),
    comparisons: 'd'.repeat(64),
  },
};
export type ReconResult = {
  status: number;
  replayed: boolean;
  body: { run_id: string; error?: { code: string }; [key: string]: unknown };
};
export async function reconciliationSandbox(metadata: typeof manifest = manifest) {
  const s = await executionSandbox();
  async function command(
    action = 'CREATE_RECONCILIATION',
    run = randomUUID(),
    key = randomUUID(),
    db: pg.Client = s.app,
  ): Promise<ReconResult> {
    const p = { run_id: run };
    return (
      await db.query<{ result: ReconResult }>(
        'SELECT fi_control.reconciliation_command($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result',
        [
          s.id,
          s.proof,
          '1',
          action,
          JSON.stringify(p),
          digest(JSON.stringify({ action, p })),
          key,
          s.actor,
          JSON.stringify(metadata),
        ],
      )
    ).rows[0]!.result;
  }
  return {
    ...s,
    reconCommand: command,
    async close() {
      const admin = await connection('admin');
      try {
        await admin.query('BEGIN');
        await admin.query("SET LOCAL session_replication_role='replica'");
        await admin.query(
          "UPDATE fi.reconciliation_runs SET requested_at=requested_at-interval '1 minute',started_at=started_at-interval '1 minute',lease_expires_at=clock_timestamp()-interval '1 second' WHERE sandbox_id=$1 AND state IN ('REQUESTED','RUNNING')",
          [s.id],
        );
        await admin.query('COMMIT');
      } finally {
        await admin.end();
      }
      await s.close();
    },
  };
}
