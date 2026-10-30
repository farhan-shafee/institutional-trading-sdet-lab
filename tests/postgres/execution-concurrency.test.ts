import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type pg from 'pg';
import { connection } from './harness.js';
import { executionSandbox } from './execution-fixture.js';
async function queued(observer: pg.Client, pid: number) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const r = await observer.query<Record<string, unknown>>(
      "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
      [pid],
    );
    if (r.rows[0]?.waiting) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error('Expected actual PostgreSQL lock barrier');
}
await test('20 simultaneous independent-connection fills admit exactly one current version', async () => {
  const s = await executionSandbox();
  const clients = await Promise.all(Array.from({ length: 20 }, () => connection('app')));
  const db = await connection('reconciler');
  try {
    await s.command('ACK_ORDER', { expected_version: '1' });
    const results = await Promise.all(
      clients.map((c) =>
        s.command(
          'EXECUTE_ORDER',
          {
            expected_version: '2',
            execution_id: randomUUID(),
            source_event_id: randomUUID(),
            par_amount: '60.00',
          },
          randomUUID(),
          c,
        ),
      ),
    );
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(results.filter((r) => r.body.error?.code === 'ORDER_VERSION_CONFLICT').length, 19);
    const state = (
      await db.query<Record<string, unknown>>(
        'SELECT filled_par::text,remaining_par::text FROM fi.order_states WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0];
    assert.deepEqual(state, { filled_par: '60.00', remaining_par: '40.00' });
    assert.equal((await s.fill('3', '60.00')).body.error?.code, 'FILL_EXCEEDS_REMAINING');
    assert.equal(
      (
        await db.query<Record<string, unknown>>('SELECT * FROM fi.executions WHERE sandbox_id=$1', [
          s.id,
        ])
      ).rowCount,
      1,
    );
  } finally {
    await Promise.all(clients.map((c) => c.end()));
    await db.end();
    await s.close();
  }
});
await test('20 duplicate source events under independent keys create one fill and 19 duplicate receipts', async () => {
  const s = await executionSandbox();
  const clients = await Promise.all(Array.from({ length: 20 }, () => connection('app')));
  try {
    await s.command('ACK_ORDER', { expected_version: '1' });
    const input = {
      expected_version: '2',
      execution_id: randomUUID(),
      source_event_id: randomUUID(),
      par_amount: '100.00',
    };
    const results = await Promise.all(
      clients.map((c) => s.command('EXECUTE_ORDER', input, randomUUID(), c)),
    );
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(results.filter((r) => r.status === 200).length, 19);
    assert.ok(results.every((r) => r.body.lifecycle.execution_count === 1));
  } finally {
    await Promise.all(clients.map((c) => c.end()));
    await s.close();
  }
});
for (const full of [false, true])
  for (const firstFill of [false, true])
    await test(`deterministic ${full ? 'full' : 'partial'} fill/cancel race: ${firstFill ? 'fill' : 'cancel'} commits first`, async () => {
      const s = await executionSandbox();
      const a = await connection('app'),
        b = await connection('app'),
        observer = await connection('admin');
      try {
        await s.command('ACK_ORDER', { expected_version: '1' });
        const cancel = randomUUID();
        await s.command('REQUEST_CANCEL', { expected_version: '2', cancel_id: cancel });
        const fill = {
          execution_id: randomUUID(),
          source_event_id: randomUUID(),
          par_amount: full ? '100.00' : '40.00',
        };
        await a.query<Record<string, unknown>>('BEGIN');
        const first = await s.command(
          firstFill ? 'EXECUTE_ORDER' : 'ACK_CANCEL',
          { expected_version: '3', ...(firstFill ? fill : { cancel_id: cancel }) },
          randomUUID(),
          a,
        );
        assert.ok([200, 201].includes(first.status));
        const pid = (await b.query<Record<string, unknown>>('SELECT pg_backend_pid() AS pid'))
          .rows[0]!.pid as number;
        const second = s.command(
          firstFill ? 'ACK_CANCEL' : 'EXECUTE_ORDER',
          { expected_version: '4', ...(firstFill ? { cancel_id: cancel } : fill) },
          randomUUID(),
          b,
        );
        await queued(observer, pid);
        await a.query<Record<string, unknown>>('COMMIT');
        const result = await second;
        if (firstFill) {
          assert.equal(result.status, 200);
          assert.equal(result.body.lifecycle.status, full ? 'FILLED' : 'CANCELED');
          assert.equal(result.body.lifecycle.filled_par, full ? '100.00' : '40.00');
          assert.equal(result.body.cancellation?.state, full ? 'REJECTED' : 'ACKNOWLEDGED');
        } else {
          assert.equal(result.body.error?.code, 'ORDER_NOT_EXECUTABLE');
          assert.equal(
            (
              await observer.query<Record<string, unknown>>(
                'SELECT * FROM fi.executions WHERE sandbox_id=$1',
                [s.id],
              )
            ).rowCount,
            0,
          );
        }
      } finally {
        await a.query<Record<string, unknown>>('ROLLBACK');
        await Promise.all([a.end(), b.end(), observer.end()]);
        await s.close();
      }
    });
