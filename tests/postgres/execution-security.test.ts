import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { connection, owner } from './harness.js';
import { executionSandbox } from './execution-fixture.js';
import { digest } from './rfq-fixture.js';
import { WorkflowDatabase } from '../../app/persistence/postgres/workflow.js';
const tables = [
  'order_states',
  'executions',
  'positions',
  'order_history',
  'cancellation_requests',
  'cancellation_outcomes',
];
await test('actual least-privileged connections force RLS and cannot write financial records or invoke private helpers', async () => {
  const s = await executionSandbox(),
    foreign = await executionSandbox();
  const admin = await connection('admin'),
    reader = await connection('reconciler');
  const owned = await owner(),
    pool = new WorkflowDatabase(owned.appUrl!);
  try {
    await s.command('ACK_ORDER', { expected_version: '1' });
    await s.fill('2', '100.00');
    for (const table of tables) {
      const r = await admin.query<Record<string, unknown>>(
        'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
        ['fi.' + table],
      );
      assert.deepEqual(r.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
      const p = await s.app.query<Record<string, unknown>>(
        "SELECT has_table_privilege(current_user,$1,'INSERT,UPDATE,DELETE,TRUNCATE') AS allowed",
        ['fi.' + table],
      );
      assert.equal(p.rows[0]!.allowed, false);
      await assert.rejects(
        s.app.query<Record<string, unknown>>(`DELETE FROM fi.${table} WHERE sandbox_id=$1`, [s.id]),
        {
          code: '42501',
        },
      );
    }
    for (const helper of [
      'fi_control.execution_cents(jsonb,numeric)',
      'fi_control.half_even(numeric,numeric)',
      'fi_control.lifecycle_body(uuid,uuid)',
    ])
      assert.equal(
        (
          await s.app.query<Record<string, unknown>>(
            "SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed",
            [helper],
          )
        ).rows[0]!.allowed,
        false,
      );
    await assert.rejects(
      s.app.query<Record<string, unknown>>(
        "UPDATE fi.audit_events SET payload='{}' WHERE sandbox_id=$1",
        [s.id],
      ),
      { code: '42501' },
    );
    assert.equal(
      (await s.app.query<Record<string, unknown>>('SELECT * FROM fi.executions')).rowCount,
      0,
    );
    await pool.transaction(
      true,
      () => undefined,
      async (db) => {
        await db.query<Record<string, unknown>>(
          "SELECT set_config('tradeflow.sandbox_id',$1,true)",
          [s.id],
        );
        assert.equal(
          (await db.query<Record<string, unknown>>('SELECT * FROM fi.executions')).rowCount,
          1,
        );
      },
    );
    await pool.transaction(
      true,
      () => undefined,
      async (db) => {
        assert.equal(
          (await db.query<Record<string, unknown>>('SELECT * FROM fi.executions')).rowCount,
          0,
        );
        await db.query<Record<string, unknown>>(
          "SELECT set_config('tradeflow.sandbox_id',$1,true)",
          [foreign.id],
        );
        assert.equal(
          (await db.query<Record<string, unknown>>('SELECT * FROM fi.executions')).rowCount,
          0,
        );
      },
    );
    assert.equal(
      (await foreign.command('ACK_ORDER', { order_id: s.order, expected_version: '1' })).status,
      404,
    );
    assert.equal(
      (
        await reader.query<Record<string, unknown>>(
          'SELECT * FROM fi.executions WHERE sandbox_id=$1',
          [s.id],
        )
      ).rowCount,
      1,
    );
    await assert.rejects(
      admin.query<Record<string, unknown>>(
        'UPDATE fi.executions SET consideration_cents=consideration_cents+1 WHERE sandbox_id=$1',
        [s.id],
      ),
      { code: '42501' },
    );
    await assert.rejects(
      admin.query<Record<string, unknown>>(
        "UPDATE fi.orders SET status='NEW' WHERE sandbox_id=$1",
        [s.id],
      ),
      { code: '42501' },
    );
  } finally {
    await pool.close();
    await reader.end();
    await admin.end();
    await foreign.close();
    await s.close();
  }
});
await test('queued execution observes committed capability rotation and denies stale proof/generation', async () => {
  const s = await executionSandbox();
  const rotating = await connection('app'),
    observer = await connection('admin');
  try {
    await s.command('ACK_ORDER', { expected_version: '1' });
    await rotating.query<Record<string, unknown>>('BEGIN');
    const result = await rotating.query<{ result: { status: number } }>(
      'SELECT fi_control.rotate_capabilities($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result',
      [
        s.id,
        s.proof,
        '1',
        '1',
        digest('newread'),
        digest('newtrade'),
        digest('rotate'),
        randomUUID(),
        s.actor,
      ],
    );
    assert.equal(result.rows[0]?.result.status, 200);
    const pid = (await s.app.query<Record<string, unknown>>('SELECT pg_backend_pid() AS pid'))
      .rows[0]!.pid as number;
    const waiting = s.fill('2', '40.00');
    const deadline = performance.now() + 3000;
    while (
      !(
        await observer.query<Record<string, unknown>>(
          "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
          [pid],
        )
      ).rows[0]?.waiting
    ) {
      assert.ok(performance.now() < deadline);
      await new Promise<void>((r) => setImmediate(r));
    }
    await rotating.query<Record<string, unknown>>('COMMIT');
    assert.equal((await waiting).body.error?.code, 'SANDBOX_NOT_FOUND');
    assert.equal(
      (
        await observer.query<Record<string, unknown>>(
          'SELECT * FROM fi.executions WHERE sandbox_id=$1',
          [s.id],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (await s.command('ACK_ORDER', { expected_version: '2' }, randomUUID(), s.app, '2')).status,
      404,
    );
  } finally {
    await rotating.query<Record<string, unknown>>('ROLLBACK');
    await rotating.end();
    await observer.end();
    await s.close();
  }
});
await test('command quota reserves capacity before financial mutation and committed fill replays at full quota', async () => {
  const s = await executionSandbox();
  const admin = await connection('admin');
  try {
    await s.command('ACK_ORDER', { expected_version: '1' });
    const key = randomUUID(),
      input = {
        expected_version: '2',
        source_event_id: randomUUID(),
        execution_id: randomUUID(),
        par_amount: '40.00',
      };
    const fill = await s.command('EXECUTE_ORDER', input, key);
    assert.equal(fill.status, 201);
    for (let n = 6; n < 512; n++)
      assert.equal((await s.command('ACK_ORDER', { expected_version: '3' })).status, 409);
    assert.equal(
      (
        await admin.query<Record<string, unknown>>(
          'SELECT command_count FROM fi.sandboxes WHERE id=$1',
          [s.id],
        )
      ).rows[0]!.command_count,
      512,
    );
    assert.equal((await s.fill('3', '60.00')).status, 429);
    assert.equal(
      (
        await admin.query<Record<string, unknown>>(
          'SELECT * FROM fi.executions WHERE sandbox_id=$1',
          [s.id],
        )
      ).rowCount,
      1,
    );
    assert.deepEqual((await s.command('EXECUTE_ORDER', input, key)).body, fill.body);
  } finally {
    await admin.end();
    await s.close();
  }
});
await test('independent SQL recognizes rejected and acknowledged cancellation histories', async () => {
  const s = await executionSandbox();
  const reader = await connection('reconciler');
  try {
    await s.command('ACK_ORDER', { expected_version: '1' });
    let version = 2;
    for (const action of ['REJECT_CANCEL', 'ACK_CANCEL']) {
      const id = randomUUID();
      await s.command('REQUEST_CANCEL', { expected_version: String(version++), cancel_id: id });
      await s.command(action, { expected_version: String(version++), cancel_id: id });
    }
    assert.equal(
      (
        await reader.query<Record<string, unknown>>(
          await readFile('verification/sql/executions.sql', 'utf8'),
        )
      ).rowCount,
      0,
    );
  } finally {
    await reader.end();
    await s.close();
  }
});
await test('eight cancellation requests stay bounded and write expiry preserves reads, original receipts and authorized full-graph cleanup', async () => {
  const s = await executionSandbox();
  const admin = await connection('admin');
  try {
    const key = randomUUID(),
      ack = { expected_version: '1' };
    assert.equal((await s.command('ACK_ORDER', ack, key)).status, 200);
    let version = 2;
    for (let n = 0; n < 8; n++) {
      const id = randomUUID();
      assert.equal(
        (await s.command('REQUEST_CANCEL', { expected_version: String(version++), cancel_id: id }))
          .status,
        201,
      );
      assert.equal(
        (await s.command('REJECT_CANCEL', { expected_version: String(version++), cancel_id: id }))
          .status,
        200,
      );
    }
    assert.equal(
      (
        await s.command('REQUEST_CANCEL', {
          expected_version: String(version),
          cancel_id: randomUUID(),
        })
      ).body.error?.code,
      'CANCEL_REQUEST_LIMIT',
    );
    await s.fill(String(version), '100.00');
    await admin.query(
      "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '8 days',write_expires_at=clock_timestamp()-interval '1 day',retained_until=clock_timestamp()+interval '22 days' WHERE id=$1",
      [s.id],
    );
    assert.equal(
      (await s.command('ACK_ORDER', { expected_version: String(version + 1) })).body.error?.code,
      'SANDBOX_EXPIRED',
    );
    assert.equal((await s.command('ACK_ORDER', ack, key)).replayed, true);
    const read = await s.app.query<{ result: { status: number } }>(
      'SELECT fi_control.read_orders($1,$2,$3,$4,$5) AS result',
      [s.id, s.proof, 'trade', '1', s.order],
    );
    assert.equal(read.rows[0]?.result.status, 200);
  } finally {
    await s.close();
    for (const table of [...tables, 'orders', 'commands', 'audit_events'])
      assert.equal(
        (await admin.query(`SELECT * FROM fi.${table} WHERE sandbox_id=$1`, [s.id])).rowCount,
        0,
      );
    await admin.end();
  }
});
await test('database command rejects JSON number financial input and exact SQL HALF_EVEN matches rational ties', async () => {
  const s = await executionSandbox();
  const admin = await connection('admin');
  try {
    await s.command('ACK_ORDER', { expected_version: '1' });
    assert.equal(
      (
        await s.command('EXECUTE_ORDER', {
          expected_version: '2',
          execution_id: randomUUID(),
          source_event_id: randomUUID(),
          par_amount: 40,
        })
      ).status,
      400,
    );
    for (const [n, d, expected] of [
      ['201', '2', '100'],
      ['203', '2', '102'],
      ['100499999', '1000000', '100'],
      ['100500001', '1000000', '101'],
    ])
      assert.equal(
        (
          await admin.query<{ cents: string }>(
            'SELECT fi_control.half_even($1,$2)::text AS cents',
            [n, d],
          )
        ).rows[0]?.cents,
        expected,
      );
  } finally {
    await admin.end();
    await s.close();
  }
});
