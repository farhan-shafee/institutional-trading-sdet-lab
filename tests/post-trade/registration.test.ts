import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connection, executionSandbox, randomUUID, postTradeSandbox } from './fixture.js';

await test('fixed economic window cannot be rewritten even by an owned writer', async () => {
  const s = await postTradeSandbox(),
    admin = await connection('admin');
  try {
    assert.equal(
      (await s.command('INITIALIZE', { economic_start_date: '2030-01-15' })).status,
      201,
    );
    await assert.rejects(
      admin.query(
        "UPDATE fi.posttrade_books SET economic_start_date='2030-01-16',economic_end_date='2030-07-15' WHERE sandbox_id=$1",
        [s.id],
      ),
      { code: '42501' },
    );
    assert.deepEqual((await s.read()).body.window, { start: '2030-01-15', end: '2030-07-15' });
    await assert.rejects(
      admin.query(
        'UPDATE fi.posttrade_books SET cash_cents=cash_cents+1,counterparty_cash_cents=counterparty_cash_cents-1 WHERE sandbox_id=$1',
        [s.id],
      ),
      { code: '23514' },
    );
  } finally {
    await admin.end();
    await s.close();
  }
});

await test('all eight actual execution roots register once; ninth raw root makes complete source unavailable', async () => {
  const s = await executionSandbox('8.00', 'BUY', 'SYN-UST-2031', '2030-01-15');
  const command = async (operation: string, payload: unknown) =>
    (
      await s.app.query<{ r: { status: number; body: Record<string, unknown> } }>(
        'SELECT fi_control.posttrade_command($1,$2,1,$3,$4,$5,$6) r',
        [s.id, s.proof, operation, JSON.stringify(payload), randomUUID(), s.actor],
      )
    ).rows[0]!.r;
  const read = async (raw: string | null = null) =>
    (
      await s.app.query<{
        r: {
          status: number;
          body: {
            coverage: { complete: boolean; reasons: string[] };
            roots: unknown[];
            inventory_truncated: boolean;
            raw_execution_count: number;
            raw_command_seq: string;
            posttrade_command_seq: string;
          };
        };
      }>("SELECT fi_control.read_posttrade($1,$2,'trade',1,$3,NULL) r", [s.id, s.proof, raw])
    ).rows[0]!.r;
  try {
    assert.equal((await s.command('ACK_ORDER', { expected_version: '1' })).status, 200);
    assert.equal((await command('INITIALIZE', { economic_start_date: '2030-01-15' })).status, 201);
    for (let i = 0; i < 8; i++) {
      const fill = await s.fill(String(i + 2), '1.00');
      assert.equal(fill.status, 201);
      const x = fill.body.execution!;
      assert.equal((await command('REGISTER', { execution_id: x.id })).status, 201);
      assert.equal((await command('REGISTER', { execution_id: x.id })).status, 409);
    }
    const complete = await read();
    assert.equal(complete.body.coverage.complete, true);
    assert.equal(complete.body.roots.length, 8);
    assert.equal(complete.body.posttrade_command_seq, '9');
    const other = await s.createOrder('1.00', 'SELL');
    assert.equal(
      (await s.command('ACK_ORDER', { order_id: other, expected_version: '1' })).status,
      200,
    );
    const ninth = (
      await s.command('EXECUTE_ORDER', {
        order_id: other,
        expected_version: '2',
        source_event_id: randomUUID(),
        execution_id: randomUUID(),
        par_amount: '1.00',
      })
    ).body.execution!;
    assert.equal((await command('REGISTER', { execution_id: ninth.id })).status, 429);
    const unavailable = await read();
    assert.equal(unavailable.body.coverage.complete, false);
    assert.ok(unavailable.body.coverage.reasons.includes('ROOT_LIMIT_EXCEEDED'));
    assert.ok(unavailable.body.coverage.reasons.includes('UNREGISTERED_EXECUTION'));
    assert.deepEqual(unavailable.body.roots, []);
    assert.equal(unavailable.body.inventory_truncated, true);
    assert.equal(unavailable.body.raw_execution_count, 9);
    assert.equal(unavailable.body.posttrade_command_seq, '9');
    const historical = await read(complete.body.raw_command_seq);
    assert.equal(historical.body.coverage.complete, true);
    assert.equal(historical.body.roots.length, 8);
  } finally {
    await s.close();
  }
});

await test('out-of-window and weekend original roots cannot be hidden by failed registration', async () => {
  for (const date of ['2030-01-19', '2030-07-15']) {
    const s = await executionSandbox('1.00', 'BUY', 'SYN-UST-2031', date);
    try {
      assert.equal((await s.command('ACK_ORDER', { expected_version: '1' })).status, 200);
      const x = (await s.fill('2', '1.00')).body.execution!;
      for (const [op, payload, status] of [
        ['INITIALIZE', { economic_start_date: '2030-01-15' }, 201],
        ['REGISTER', { execution_id: x.id }, 409],
      ] as const) {
        const result = (
          await s.app.query<{ r: { status: number } }>(
            'SELECT fi_control.posttrade_command($1,$2,1,$3,$4,$5,$6) r',
            [s.id, s.proof, op, JSON.stringify(payload), randomUUID(), s.actor],
          )
        ).rows[0]!.r;
        assert.equal(result.status, status);
      }
      const source = (
        await s.app.query<{ r: { body: { coverage: { complete: boolean; reasons: string[] } } } }>(
          "SELECT fi_control.read_posttrade($1,$2,'trade',1,NULL,NULL) r",
          [s.id, s.proof],
        )
      ).rows[0]!.r.body;
      assert.equal(source.coverage.complete, false);
      assert.ok(source.coverage.reasons.includes('EXECUTION_OUTSIDE_ECONOMIC_WINDOW'));
    } finally {
      await s.close();
    }
  }
});
