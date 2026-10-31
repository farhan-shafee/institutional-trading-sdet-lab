import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { connection } from './harness.js';
import { reconciliationSandbox, manifest, type ReconResult } from './reconciliation-fixture.js';
await test('durable reconciliation request is owned, idempotent and does not change financial records', async () => {
  const s = await reconciliationSandbox();
  const reader = await connection('reconciler');
  try {
    const run = randomUUID(),
      key = randomUUID();
    const a = await s.reconCommand('CREATE_RECONCILIATION', run, key);
    assert.equal(a.status, 201);
    assert.equal(a.body.run_id, run);
    const b = await s.reconCommand('CREATE_RECONCILIATION', run, key);
    assert.equal(b.replayed, true);
    assert.deepEqual(b.body, a.body);
    assert.equal(
      (await s.reconCommand('CREATE_RECONCILIATION', randomUUID(), key)).body.error?.code,
      'IDEMPOTENCY_KEY_REUSED',
    );
    assert.equal((await s.reconCommand()).body.error?.code, 'RECONCILIATION_ACTIVE');
    assert.equal(
      (await reader.query('SELECT * FROM fi.executions WHERE sandbox_id=$1', [s.id])).rowCount,
      0,
    );
  } finally {
    await reader.end();
    await s.close();
  }
});
await test('snapshot result recording is separately privileged and completed clean cannot be fabricated from missing coverage', async () => {
  const s = await reconciliationSandbox();
  const reader = await connection('reconciler');
  try {
    const run = randomUUID(),
      worker = randomUUID();
    await s.reconCommand('CREATE_RECONCILIATION', run);
    await assert.rejects(
      s.app.query('SELECT fi_control.claim_reconciliation($1,$2,$3,$4,$5,$6)', [
        s.id,
        s.proof,
        '1',
        run,
        worker,
        JSON.stringify(manifest),
      ]),
      { code: '42501' },
    );
    const claim = await reader.query<{ result: ReconResult }>(
      'SELECT fi_control.claim_reconciliation($1,$2,$3,$4,$5,$6) AS result',
      [s.id, s.proof, '1', run, worker, JSON.stringify(manifest)],
    );
    assert.equal(claim.rows[0]?.result.status, 200);
    const result = await reader.query<{ result: ReconResult }>(
      'SELECT fi_control.finish_reconciliation($1,$2,$3,$4,$5,$6) AS result',
      [
        s.id,
        s.proof,
        '1',
        run,
        worker,
        JSON.stringify({
          status: 'COMPLETED_CLEAN',
          snapshot: null,
          coverage: [],
          findings: [],
          total_findings: 0,
          failure_reason: null,
        }),
      ],
    );
    assert.equal(result.rows[0]?.result.status, 400);
    assert.equal(
      (
        await reader.query<{ state: string }>(
          'SELECT state FROM fi.reconciliation_runs WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]?.state,
      'RUNNING',
    );
  } finally {
    await reader.end();
    await s.close();
  }
});
await test('missing coverage status cannot become completed clean through NULL SQL semantics', async () => {
  const s = await reconciliationSandbox();
  const worker = await connection('reconciler');
  try {
    const run = randomUUID(),
      wid = randomUUID();
    await s.reconCommand('CREATE_RECONCILIATION', run);
    await worker.query('SELECT fi_control.claim_reconciliation($1,$2,$3,$4,$5,$6)', [
      s.id,
      s.proof,
      '1',
      run,
      wid,
      JSON.stringify(manifest),
    ]);
    const snap = (
      await worker.query<{ id: string; at: Date; watermark: string }>(
        'SELECT pg_current_snapshot()::text AS id,clock_timestamp() AS at,(SELECT max(command_seq)::text FROM fi.commands WHERE sandbox_id=$1) AS watermark',
        [s.id],
      )
    ).rows[0]!;
    const coverage: { name: string; hash: string; rows: number; status: string | undefined }[] =
      Object.entries(manifest.query_hashes).map(([name, hash]) => ({
        name,
        hash,
        rows: 0,
        status: 'COMPLETE',
      }));
    coverage[0]!.status = undefined;
    const r = await worker.query<{ result: ReconResult }>(
      'SELECT fi_control.finish_reconciliation($1,$2,$3,$4,$5,$6) AS result',
      [
        s.id,
        s.proof,
        '1',
        run,
        wid,
        JSON.stringify({
          status: 'COMPLETED_CLEAN',
          snapshot: { ...snap, at: snap.at.toISOString() },
          coverage,
          findings: [],
          total_findings: 0,
          failure_reason: null,
        }),
      ],
    );
    assert.equal(r.rows[0]?.result.status, 400);
  } finally {
    await worker.end();
    await s.close();
  }
});
await test('reconciliation can be requested when financial audit counters are corrupt without changing the trading ledger', async () => {
  const s = await reconciliationSandbox();
  const admin = await connection('admin');
  try {
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    await admin.query(
      'DELETE FROM fi.audit_events WHERE sandbox_id=$1 AND command_seq=4 AND event_index=2',
      [s.id],
    );
    await admin.query('COMMIT');
    const before = (
      await admin.query(
        'SELECT command_count,event_count,commit_seq FROM fi.sandboxes WHERE id=$1',
        [s.id],
      )
    ).rows;
    assert.equal((await s.reconCommand()).status, 201);
    assert.deepEqual(
      (
        await admin.query(
          'SELECT command_count,event_count,commit_seq FROM fi.sandboxes WHERE id=$1',
          [s.id],
        )
      ).rows,
      before,
    );
  } finally {
    await admin.end();
    await s.close();
  }
});
await test('metadata command receipt preserves authenticated actor identity independently of financial commands', async () => {
  const s = await reconciliationSandbox();
  const reader = await connection('reconciler');
  try {
    const run = randomUUID();
    await s.reconCommand('CREATE_RECONCILIATION', run);
    const receipt = await reader.query<{ actor_id: string }>(
      'SELECT actor_id FROM fi.reconciliation_commands WHERE sandbox_id=$1',
      [s.id],
    );
    assert.equal(receipt.rows[0]?.actor_id, s.actor);
  } finally {
    await reader.end();
    await s.close();
  }
});
