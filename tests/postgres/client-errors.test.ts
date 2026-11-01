import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type pg from 'pg';
import { WorkflowDatabase } from '../../app/persistence/postgres/workflow.js';
import { VerificationDatabase } from '../../app/server/reconciliation/database.js';
import { connection, owner } from './harness.js';
import { executionSandbox } from './execution-fixture.js';
import { reconciliationSandbox } from './reconciliation-fixture.js';
import { digest } from './rfq-fixture.js';

for (const committed of [false, true]) {
  await test(`checked-out backend error fully delivered ${committed ? 'after' : 'before'} COMMIT retains original-key recovery`, async () => {
    const s = await executionSandbox();
    const admin = await connection('admin');
    const own = await owner();
    let active: pg.PoolClient | undefined;
    const terminate = async () => {
      assert(active);
      const pid = (await active.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
        .pid;
      // Observe end without events.once(), whose automatic error listener would
      // accidentally supply the missing product ownership being tested.
      const ended = new Promise<void>((resolve) => active!.once('end', resolve));
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      await ended;
    };
    const db = new WorkflowDatabase(
      own.appUrl!,
      committed ? { afterCommit: terminate } : { beforeCommit: terminate },
    );
    try {
      await s.command('ACK_ORDER', { expected_version: '1' });
      const payload = {
          order_id: s.order,
          expected_version: '2',
          execution_id: randomUUID(),
          source_event_id: randomUUID(),
          par_amount: '40.00',
        },
        key = randomUUID();
      await assert.rejects(
        db.transaction(
          false,
          () => {},
          async (client) => {
            active = client;
            return client.query('SELECT fi_control.order_command($1,$2,$3,$4,$5,$6,$7,$8)', [
              s.id,
              s.proof,
              '1',
              'EXECUTE_ORDER',
              JSON.stringify(payload),
              digest(JSON.stringify({ action: 'EXECUTE_ORDER', payload })),
              key,
              s.actor,
            ]);
          },
        ),
        { code: 'OUTCOME_UNKNOWN', status: 503 },
      );
      const replay = await s.command('EXECUTE_ORDER', payload, key);
      assert.equal(replay.status, 201);
      assert.equal(replay.replayed, committed);
      assert.equal(replay.body.lifecycle.execution_count, 1);
      assert.equal(
        (
          await admin.query<{ count: number }>(
            'SELECT count(*)::integer AS count FROM fi.executions WHERE sandbox_id=$1',
            [s.id],
          )
        ).rows[0]!.count,
        1,
      );
      assert.equal(
        (
          await admin.query<{ execution_count: number }>(
            'SELECT execution_count FROM fi.positions WHERE sandbox_id=$1',
            [s.id],
          )
        ).rows[0]!.execution_count,
        1,
      );
    } finally {
      await db.close();
      await admin.end();
      await s.close();
    }
  });
}

await test('read-only reconciliation rejects a fully delivered checked-out backend error without publishing a result', async () => {
  const s = await reconciliationSandbox();
  const admin = await connection('admin');
  const own = await owner();
  const db = new VerificationDatabase(own.reconcilerUrl!);
  try {
    await assert.rejects(
      db.transaction(
        true,
        () => {},
        async (client) => {
          const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
            .rows[0]!.pid;
          const ended = new Promise<void>((resolve) => client.once('end', resolve));
          await admin.query('SELECT pg_terminate_backend($1)', [pid]);
          await ended;
          return 'must not become an authoritative verification result';
        },
      ),
      { code: 'RECONCILER_UNAVAILABLE', status: 503 },
    );
    assert.equal(
      (
        await admin.query<{ count: number }>(
          'SELECT count(*)::integer AS count FROM fi.reconciliation_runs WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.count,
      0,
    );
    assert.equal(
      (
        await admin.query<{ count: number }>(
          'SELECT count(*)::integer AS count FROM fi.orders WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.count,
      1,
    );
  } finally {
    await db.close();
    await admin.end();
    await s.close();
  }
});
