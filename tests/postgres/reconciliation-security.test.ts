import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { owner, connection } from './harness.js';
import { reconciliationSandbox } from './reconciliation-fixture.js';
import { verificationManifest } from '../../app/server/reconciliation/manifest.js';
import { ReconciliationRunner } from '../../app/server/reconciliation/runner.js';
await test('twenty concurrent same-key requests produce one metadata receipt/run and two distinct keys admit one active run', async () => {
  const s = await reconciliationSandbox(),
    clients = await Promise.all(Array.from({ length: 20 }, () => connection('app'))),
    reader = await connection('reconciler');
  try {
    const run = randomUUID(),
      key = randomUUID();
    const results = await Promise.all(
      clients.map((c) => s.reconCommand('CREATE_RECONCILIATION', run, key, c)),
    );
    assert.equal(results.filter((r) => r.status === 201).length, 20);
    assert.equal(results.filter((r) => r.replayed).length, 19);
    assert.ok(results.every((r) => r.body.run_id === run));
    assert.equal(
      (await reader.query('SELECT * FROM fi.reconciliation_runs WHERE sandbox_id=$1', [s.id]))
        .rowCount,
      1,
    );
    assert.equal(
      (await reader.query('SELECT * FROM fi.reconciliation_commands WHERE sandbox_id=$1', [s.id]))
        .rowCount,
      1,
    );
    const more = await Promise.all(
      clients
        .slice(0, 2)
        .map((c) => s.reconCommand('CREATE_RECONCILIATION', randomUUID(), randomUUID(), c)),
    );
    assert.ok(more.every((r) => r.body.error?.code === 'RECONCILIATION_ACTIVE'));
  } finally {
    await Promise.all(clients.map((c) => c.end()));
    await reader.end();
    await s.close();
  }
  const t = await reconciliationSandbox(),
    a = await connection('app'),
    b = await connection('app');
  try {
    const r = await Promise.all([
      t.reconCommand('CREATE_RECONCILIATION', randomUUID(), randomUUID(), a),
      t.reconCommand('CREATE_RECONCILIATION', randomUUID(), randomUUID(), b),
    ]);
    assert.equal(r.filter((x) => x.status === 201).length, 1);
    assert.equal(r.filter((x) => x.status === 409).length, 1);
  } finally {
    await a.end();
    await b.end();
    await t.close();
  }
});
await test('real roles force RLS and deny arbitrary findings, result recording, private key access and financial writes', async () => {
  const s = await reconciliationSandbox(),
    foreign = await reconciliationSandbox(),
    reader = await connection('reconciler'),
    admin = await connection('admin');
  try {
    const run = randomUUID();
    await s.reconCommand('CREATE_RECONCILIATION', run);
    for (const table of [
      'reconciliation_runs',
      'reconciliation_findings',
      'reconciliation_events',
      'reconciliation_commands',
    ]) {
      assert.deepEqual(
        (
          await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
            'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
            ['fi.' + table],
          )
        ).rows[0],
        { relrowsecurity: true, relforcerowsecurity: true },
      );
      for (const role of [s.app, reader])
        assert.equal(
          (
            await role.query<{ allowed: boolean }>(
              "SELECT has_table_privilege(current_user,$1,'INSERT,UPDATE,DELETE,TRUNCATE') AS allowed",
              ['fi.' + table],
            )
          ).rows[0]?.allowed,
          false,
        );
      await assert.rejects(s.app.query(`DELETE FROM fi.${table} WHERE sandbox_id=$1`, [s.id]), {
        code: '42501',
      });
    }
    assert.equal((await s.app.query('SELECT * FROM fi.reconciliation_runs')).rowCount, 0);
    await assert.rejects(s.app.query('SELECT * FROM fi_control.command_keys'), { code: '42501' });
    await assert.rejects(
      reader.query('UPDATE fi.executions SET consideration_cents=1 WHERE sandbox_id=$1', [s.id]),
      { code: '42501' },
    );
    const denied = await foreign.app.query<{ result: { status: number } }>(
      'SELECT fi_control.read_reconciliations($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result',
      [foreign.id, foreign.proof, 'trade', '1', run, 'detail', 0, null, 20, null],
    );
    assert.equal(denied.rows[0]?.result.status, 404);
  } finally {
    await admin.end();
    await reader.end();
    await foreign.close();
    await s.close();
  }
});
await test('run/receipt quotas remain bounded, original requests replay at capacity, and financial counters do not change', async () => {
  const metadata = await verificationManifest(),
    s = await reconciliationSandbox(metadata),
    owned = await owner();
  const runner = new ReconciliationRunner(owned.reconcilerUrl!),
    reader = await connection('reconciler');
  try {
    const key = randomUUID(),
      run = randomUUID();
    const original = await s.reconCommand('CREATE_RECONCILIATION', run, key);
    await runner.execute(
      { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' },
      run,
      metadata,
      () => undefined,
    );
    for (let n = 1; n < 20; n++) {
      const id = randomUUID();
      assert.equal((await s.reconCommand('CREATE_RECONCILIATION', id)).status, 201);
      await runner.execute(
        { sandboxId: s.id, digest: s.proof, generation: '1', scope: 'trade' },
        id,
        metadata,
        () => undefined,
      );
    }
    assert.equal((await s.reconCommand()).status, 429);
    for (let n = 20; n < 64; n++)
      assert.equal((await s.reconCommand('RECOVER_RECONCILIATION', run)).status, 200);
    assert.equal(
      (await s.reconCommand('RECOVER_RECONCILIATION', run)).body.error?.code,
      'RECONCILIATION_QUOTA',
    );
    const replay = await s.reconCommand('CREATE_RECONCILIATION', run, key);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, original.body);
    assert.equal(
      (
        await reader.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM fi.reconciliation_commands WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]?.n,
      '64',
    );
    assert.equal(
      (
        await reader.query<{ command_count: number }>(
          'SELECT command_count FROM fi.sandboxes WHERE id=$1',
          [s.id],
        )
      ).rows[0]?.command_count,
      4,
    );
  } finally {
    await runner.close();
    await reader.end();
    await s.close();
  }
});
await test('authorized retention cleanup preserves a live run lease and removes the full expired owned control graph after expiry', async () => {
  const s = await reconciliationSandbox(),
    reader = await connection('reconciler'),
    admin = await connection('admin'),
    maintenance = await connection('maintenance');
  try {
    const run = randomUUID();
    await s.reconCommand('CREATE_RECONCILIATION', run);
    await reader.query('SELECT fi_control.claim_reconciliation($1,$2,$3,$4,$5,$6)', [
      s.id,
      s.proof,
      '1',
      run,
      randomUUID(),
      JSON.stringify((await import('./reconciliation-fixture.js')).manifest),
    ]);
    await admin.query(
      "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '40 days',write_expires_at=clock_timestamp()-interval '33 days',retained_until=clock_timestamp()-interval '10 days' WHERE id=$1",
      [s.id],
    );
    await maintenance.query('SELECT fi_control.purge_expired()');
    assert.equal(
      (await reader.query('SELECT * FROM fi.reconciliation_runs WHERE sandbox_id=$1', [s.id]))
        .rowCount,
      1,
    );
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    await admin.query(
      "UPDATE fi.reconciliation_runs SET requested_at=requested_at-interval '1 minute',started_at=started_at-interval '1 minute',lease_expires_at=clock_timestamp()-interval '1 second' WHERE sandbox_id=$1",
      [s.id],
    );
    await admin.query('COMMIT');
    await maintenance.query('SELECT fi_control.purge_expired()');
    for (const table of [
      'fi.reconciliation_runs',
      'fi.reconciliation_commands',
      'fi.reconciliation_events',
      'fi.reconciliation_findings',
      'fi_control.reconciliation_capacity',
      'fi_control.command_keys',
    ])
      assert.equal(
        (await admin.query(`SELECT * FROM ${table} WHERE sandbox_id=$1`, [s.id])).rowCount,
        0,
      );
  } finally {
    await reader.end();
    await admin.end();
    await maintenance.end();
    await s.close();
  }
});
await test('real execution uniqueness and composite foreign keys reject duplicate and cross-sandbox references', async () => {
  const s = await reconciliationSandbox(),
    foreign = await reconciliationSandbox(),
    admin = await connection('admin');
  try {
    await s.command('ACK_ORDER', { expected_version: '1' });
    await s.fill('2', '100.00');
    await assert.rejects(
      admin.query(
        "INSERT INTO fi.executions SELECT (jsonb_populate_record(NULL::fi.executions,to_jsonb(e)||jsonb_build_object('id',gen_random_uuid()))).* FROM fi.executions e WHERE sandbox_id=$1",
        [s.id],
      ),
      { code: '23505' },
    );
    await assert.rejects(
      admin.query(
        "INSERT INTO fi.executions SELECT (jsonb_populate_record(NULL::fi.executions,to_jsonb(e)||jsonb_build_object('id',gen_random_uuid(),'source_event_id',gen_random_uuid(),'order_id',$2::uuid))).* FROM fi.executions e WHERE sandbox_id=$1",
        [s.id, foreign.order],
      ),
      { code: '23503' },
    );
  } finally {
    await admin.query('ROLLBACK');
    await admin.end();
    await foreign.close();
    await s.close();
  }
});
await test('an interrupted active run retains reserved recovery capacity after metadata receipt exhaustion', async () => {
  const s = await reconciliationSandbox(),
    admin = await connection('admin'),
    reader = await connection('reconciler');
  try {
    const run = randomUUID();
    await s.reconCommand('CREATE_RECONCILIATION', run);
    for (let n = 1; n < 63; n++) assert.equal((await s.reconCommand()).status, 409);
    assert.equal((await s.reconCommand()).status, 429);
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role='replica'");
    await admin.query(
      "UPDATE fi.reconciliation_runs SET requested_at=requested_at-interval '1 minute' WHERE sandbox_id=$1",
      [s.id],
    );
    await admin.query('COMMIT');
    assert.equal((await s.reconCommand('RECOVER_RECONCILIATION', run)).status, 200);
    assert.equal(
      (
        await reader.query<{ state: string }>(
          'SELECT state FROM fi.reconciliation_runs WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]?.state,
      'INCOMPLETE',
    );
    assert.equal(
      (
        await reader.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM fi.reconciliation_commands WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]?.n,
      '64',
    );
  } finally {
    await admin.end();
    await reader.end();
    await s.close();
  }
});
