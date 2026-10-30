import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { connection, owner } from './harness.js';
import { digest } from './rfq-fixture.js';
import { executionSandbox } from './execution-fixture.js';
import { WorkflowDatabase } from '../../app/persistence/postgres/workflow.js';
for (const committed of [false, true])
  await test(`actual process SIGKILL ${committed ? 'after' : 'before'} execution COMMIT recovers one ledger entry and position`, async () => {
    const s = await executionSandbox();
    const reader = await connection('reconciler');
    let child: ReturnType<typeof spawn> | undefined;
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
      child = spawn(
        process.execPath,
        ['--import', 'tsx', 'tests/postgres/execution-crash-worker.ts'],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: process.env },
      );
      const ready = once(child, 'message');
      child.send({
        commit: committed,
        args: [
          s.id,
          s.proof,
          '1',
          'EXECUTE_ORDER',
          JSON.stringify(payload),
          digest(JSON.stringify({ action: 'EXECUTE_ORDER', payload })),
          key,
          s.actor,
        ],
      });
      const [message] = (await ready) as [{ phase: string }];
      assert.equal(message.phase, committed ? 'committed' : 'uncommitted');
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
      const result = await s.command('EXECUTE_ORDER', payload, key);
      assert.equal(result.status, 201);
      assert.equal(result.replayed, committed);
      assert.equal(result.body.lifecycle.filled_par, '40.00');
      assert.equal(
        (
          await reader.query<Record<string, unknown>>(
            'SELECT * FROM fi.executions WHERE sandbox_id=$1',
            [s.id],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await reader.query<Record<string, unknown>>(
            'SELECT execution_count FROM fi.positions WHERE sandbox_id=$1',
            [s.id],
          )
        ).rows[0].execution_count,
        1,
      );
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const done = once(child, 'exit');
        child.kill('SIGKILL');
        await done;
      }
      await reader.end();
      await s.close();
    }
  });
for (const committed of [false, true])
  await test(`actual connection termination ${committed ? 'after' : 'before'} COMMIT returns unknown and original key resolves authoritatively`, async () => {
    const s = await executionSandbox();
    const admin = await connection('admin');
    const own = await owner();
    let pid = 0;
    const kill = async () => {
      await admin.query<Record<string, unknown>>('SELECT pg_terminate_backend($1)', [pid]);
    };
    const db = new WorkflowDatabase(
      own.appUrl!,
      committed
        ? {
            afterCommit: async () => {
              await kill();
              throw new Error('Injected post-COMMIT transport failure');
            },
          }
        : { beforeCommit: kill },
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
      const args = [
        s.id,
        s.proof,
        '1',
        'EXECUTE_ORDER',
        JSON.stringify(payload),
        digest(JSON.stringify({ action: 'EXECUTE_ORDER', payload })),
        key,
        s.actor,
      ];
      await assert.rejects(
        db.transaction(
          false,
          () => undefined,
          async (client) => {
            pid = (await client.query<Record<string, unknown>>('SELECT pg_backend_pid() AS pid'))
              .rows[0].pid as number;
            return client.query<Record<string, unknown>>(
              'SELECT fi_control.order_command($1,$2,$3,$4,$5,$6,$7,$8)',
              args,
            );
          },
        ),
        { code: 'OUTCOME_UNKNOWN' },
      );
      const replay = await s.command('EXECUTE_ORDER', payload, key);
      assert.equal(replay.status, 201);
      assert.equal(replay.replayed, committed);
      assert.equal(replay.body.lifecycle.execution_count, 1);
    } finally {
      await db.close();
      await admin.end();
      await s.close();
    }
  });
await test('fault after execution insertion rolls back ledger, positions, state, audit and receipt together', async () => {
  const s = await executionSandbox();
  const admin = await connection('admin');
  try {
    await s.command('ACK_ORDER', { expected_version: '1' });
    const counters = (
      await admin.query<Record<string, unknown>>(
        'SELECT command_count,event_count FROM fi.sandboxes WHERE id=$1',
        [s.id],
      )
    ).rows;
    await admin.query<Record<string, unknown>>(
      "CREATE FUNCTION fi_control.test_position_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Deliberate position fault'; END $$",
    );
    await admin.query<Record<string, unknown>>(
      'CREATE TRIGGER test_position_fault BEFORE INSERT ON fi.positions FOR EACH ROW EXECUTE FUNCTION fi_control.test_position_fault()',
    );
    const key = randomUUID(),
      input = {
        expected_version: '2',
        execution_id: randomUUID(),
        source_event_id: randomUUID(),
        par_amount: '40.00',
      };
    await assert.rejects(s.command('EXECUTE_ORDER', input, key), /Deliberate position fault/);
    assert.equal(
      (
        await admin.query<Record<string, unknown>>(
          'SELECT * FROM fi.executions WHERE sandbox_id=$1',
          [s.id],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await admin.query<Record<string, unknown>>(
          'SELECT * FROM fi.positions WHERE sandbox_id=$1',
          [s.id],
        )
      ).rowCount,
      0,
    );
    assert.deepEqual(
      (
        await admin.query<Record<string, unknown>>(
          'SELECT command_count,event_count FROM fi.sandboxes WHERE id=$1',
          [s.id],
        )
      ).rows,
      counters,
    );
    await admin.query<Record<string, unknown>>('DROP TRIGGER test_position_fault ON fi.positions');
    await admin.query<Record<string, unknown>>('DROP FUNCTION fi_control.test_position_fault()');
    assert.equal((await s.command('EXECUTE_ORDER', input, key)).status, 201);
  } finally {
    await admin.query<Record<string, unknown>>(
      'DROP TRIGGER IF EXISTS test_position_fault ON fi.positions',
    );
    await admin.query<Record<string, unknown>>(
      'DROP FUNCTION IF EXISTS fi_control.test_position_fault()',
    );
    await admin.end();
    await s.close();
  }
});
