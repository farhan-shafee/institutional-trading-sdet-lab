import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { owner, connection } from './harness.js';
import { reconciliationSandbox } from './reconciliation-fixture.js';
import { verificationManifest } from '../../app/server/reconciliation/manifest.js';
import { ReconciliationRunner } from '../../app/server/reconciliation/runner.js';
await test('a fill committed during reconciliation is outside its stable read-only snapshot and financial watermark', async () => {
  const metadata = await verificationManifest(),
    s = await reconciliationSandbox(metadata),
    owned = await owner();
  let reached!: () => void, release!: () => void;
  const barrier = new Promise<void>((r) => {
      reached = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const runner = new ReconciliationRunner(owned.reconcilerUrl!, {
    afterSnapshot: async () => {
      reached();
      await gate;
    },
  });
  const reader = await connection('reconciler');
  try {
    await s.command('ACK_ORDER', { expected_version: '1' });
    const run = randomUUID();
    await s.reconCommand('CREATE_RECONCILIATION', run);
    const work = runner.execute(
      { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' },
      run,
      metadata,
      () => undefined,
    );
    await barrier;
    assert.equal((await s.fill('2', '100.00')).status, 201);
    release();
    await work;
    const result = (
      await reader.query<{ state: string; source_watermark: string }>(
        'SELECT state,source_watermark::text FROM fi.reconciliation_runs WHERE sandbox_id=$1 AND id=$2',
        [s.id, run],
      )
    ).rows[0]!;
    assert.equal(result.state, 'COMPLETED_CLEAN');
    assert.equal(result.source_watermark, '5');
    assert.equal(
      (
        await reader.query<{ seq: string }>(
          'SELECT max(command_seq)::text AS seq FROM fi.commands WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]?.seq,
      '6',
    );
  } finally {
    release();
    await runner.close();
    await reader.end();
    await s.close();
  }
});
await test('an actual PostgreSQL query error after partial coverage records FAILED and never clean', async () => {
  const metadata = await verificationManifest(),
    s = await reconciliationSandbox(metadata),
    owned = await owner();
  const runner = new ReconciliationRunner(owned.reconcilerUrl!, {
    beforeQuery: async (name, c) => {
      if (name === 'executions') await c.query('SELECT 1/0');
    },
  });
  const reader = await connection('reconciler');
  try {
    const run = randomUUID();
    await s.reconCommand('CREATE_RECONCILIATION', run);
    await runner.execute(
      { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' },
      run,
      metadata,
      () => undefined,
    );
    const result = (
      await reader.query<{
        state: string;
        complete: boolean;
        failure_reason: string;
        coverage: { status: string }[];
      }>(
        'SELECT state,complete,failure_reason,coverage FROM fi.reconciliation_runs WHERE sandbox_id=$1 AND id=$2',
        [s.id, run],
      )
    ).rows[0]!;
    assert.equal(result.state, 'FAILED');
    assert.equal(result.complete, false);
    assert.equal(result.failure_reason, 'SQL_FAILURE');
    assert.deepEqual(
      result.coverage.map((c) => c.status),
      ['COMPLETE', 'COMPLETE', 'FAILED', 'NOT_RUN'],
    );
  } finally {
    await runner.close();
    await reader.end();
    await s.close();
  }
});
await test('findings over the bounded result capacity produce INCOMPLETE with retained evidence', async () => {
  const metadata = await verificationManifest(),
    s = await reconciliationSandbox(metadata),
    owned = await owner();
  const runner = new ReconciliationRunner(owned.reconcilerUrl!),
    reader = await connection('reconciler'),
    admin = await connection('admin');
  try {
    await s.command('ACK_ORDER', { expected_version: '1' });
    await s.fill('2', '100.00');
    for (let n = 0; n < 44; n++) {
      const id = await s.createOrder('100.00');
      await s.command('ACK_ORDER', { order_id: id, expected_version: '1' });
      await s.command('EXECUTE_ORDER', {
        order_id: id,
        expected_version: '2',
        execution_id: randomUUID(),
        source_event_id: randomUUID(),
        par_amount: '100.00',
      });
    }
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    await admin.query('UPDATE fi.order_states SET filled_par=filled_par-1 WHERE sandbox_id=$1', [
      s.id,
    ]);
    await admin.query('COMMIT');
    const run = randomUUID();
    await s.reconCommand('CREATE_RECONCILIATION', run);
    await runner.execute(
      { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' },
      run,
      metadata,
      () => undefined,
    );
    const r = (
      await reader.query<{
        state: string;
        complete: boolean;
        finding_count: number;
        total_findings: number;
        failure_reason: string;
      }>(
        'SELECT state,complete,finding_count,total_findings,failure_reason FROM fi.reconciliation_runs WHERE sandbox_id=$1 AND id=$2',
        [s.id, run],
      )
    ).rows[0]!;
    assert.equal(r.state, 'INCOMPLETE');
    assert.equal(r.complete, false);
    assert.equal(r.finding_count, 128);
    assert.ok(r.total_findings > 128);
    assert.equal(r.failure_reason, 'FINDING_LIMIT');
  } finally {
    await runner.close();
    await reader.end();
    await admin.end();
    await s.close();
  }
});
