import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connection, randomUUID } from './fixture.js';
import { fundedBook, available, duePayload } from './settlement-fixture.js';
await test('all eight roots consume exactly the accepted97-command161-event lifetime without changing raw executions', async () => {
  const s = await fundedBook({ parentPar: '480000000.00', fillPar: '60000000.00' }),
    admin = await connection('admin');
  const roots = [s.raw],
    receipts: {
      op: string;
      payload: unknown;
      key: string;
      status: number;
      body: Record<string, unknown>;
    }[] = [];
  async function execute(op: string, payload: unknown, status: number) {
    const key = randomUUID(),
      reply = await s.post(op, payload, key);
    assert.equal(reply.status, status, op);
    receipts.push({ op, payload, key, status, body: reply.body });
    return reply;
  }
  const settle = (id: string, revision: number) => execute('SETTLE', duePayload(id, revision), 200);
  const reverse = (id: string, revision: number) =>
    execute('REVERSE', duePayload(id, revision), 200);
  const correct = (id: string, revision: number) =>
    execute(
      'CORRECT_PRICE',
      {
        execution_id: id,
        expected_revision: revision,
        clean_price: revision === 0 ? '100.000000000000' : '101.000000000000',
      },
      201,
    );
  try {
    for (let i = 1; i < 8; i++) {
      const fill = await s.fill(String(i + 2), '60000000.00');
      assert.equal(fill.status, 201);
      roots.push(fill.body.execution!);
      assert.equal((await s.post('REGISTER', { execution_id: roots[i]!.id })).status, 201);
    }
    for (const root of roots)
      assert.ok(
        BigInt(root.consideration_cents) > 5000000000n &&
          BigInt(root.consideration_cents) < 10000000000n,
      );
    await admin.query('SET ROLE tf_owner');
    try {
      let count = (
        await admin.query<{ n: number }>('SELECT command_count n FROM fi.sandboxes WHERE id=$1', [
          s.id,
        ])
      ).rows[0]!.n;
      for (; count < 415; count++)
        await admin.query(
          'SELECT fi_control.record_rfq_command($1,$2,$3,$4,409,$5,$6,$7,clock_timestamp())',
          [
            s.id,
            randomUUID(),
            'a'.repeat(64),
            'RESPOND_DEALER',
            JSON.stringify({ error: { code: 'RFQ_VERSION_CONFLICT' } }),
            JSON.stringify([
              { type: 'COMMAND_REJECTED', payload: { code: 'RFQ_VERSION_CONFLICT' } },
            ]),
            s.actor,
          ],
        );
    } finally {
      await admin.query('RESET ROLE');
    }
    const legacySnapshot = async () => {
      const result: Record<string, string> = {};
      for (const table of [
        'sandboxes',
        'executions',
        'orders',
        'order_states',
        'positions',
        'commands',
        'audit_events',
        'fix_commands',
        'fix_events',
      ]) {
        const key = table === 'sandboxes' ? 'id' : 'sandbox_id';
        result[table] = (
          await admin.query<{ hash: string }>(
            "SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]')::text,'UTF8')),'hex') hash FROM fi." +
              table +
              ' x WHERE ' +
              key +
              '=$1',
            [s.id],
          )
        ).rows[0]!.hash;
      }
      result['legacy_keys'] = (
        await admin.query<{ hash: string }>(
          "SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]')::text,'UTF8')),'hex') hash FROM fi_control.command_keys x WHERE sandbox_id=$1 AND domain<>'POSTTRADE'",
          [s.id],
        )
      ).rows[0]!.hash;
      return result;
    };
    const legacyBefore = await legacySnapshot();
    const original = (
      await admin.query<{ raw: unknown }>(
        'SELECT jsonb_agg(to_jsonb(x) ORDER BY id) raw FROM fi.executions x WHERE sandbox_id=$1',
        [s.id],
      )
    ).rows[0]!.raw;
    await settle(roots[0]!.id, 0);
    for (let i = 1; i < 8; i++) {
      for (let failure = 0; failure < 2; failure++) {
        const failed = await execute('SETTLE', duePayload(roots[i]!.id), 409);
        assert.equal(failed.body['settlement_state'], 'FAILED');
      }
      await reverse(roots[i - 1]!.id, 0);
      await settle(roots[i]!.id, 0);
    }
    await correct(roots[0]!.id, 0);
    for (let failure = 0; failure < 2; failure++)
      await execute('SETTLE', duePayload(roots[0]!.id, 1), 409);
    await reverse(roots[7]!.id, 0);
    await settle(roots[0]!.id, 1);
    await reverse(roots[0]!.id, 1);
    await correct(roots[0]!.id, 1);
    await settle(roots[0]!.id, 2);
    await reverse(roots[0]!.id, 2);
    await execute('BUST', { execution_id: roots[0]!.id, expected_revision: 2 }, 201);
    for (let i = 1; i < 8; i++) {
      await correct(roots[i]!.id, 0);
      await settle(roots[i]!.id, 1);
      await reverse(roots[i]!.id, 1);
      await correct(roots[i]!.id, 1);
      await settle(roots[i]!.id, 2);
      await reverse(roots[i]!.id, 2);
      await execute('BUST', { execution_id: roots[i]!.id, expected_revision: 2 }, 201);
    }
    const counts = (
      await admin.query<{
        commands: number;
        events: number;
        pc: number;
        pe: number;
        cash: string;
        par: string;
        econ_cash: string;
        econ_par: string;
      }>(
        `SELECT (SELECT count(*)::int FROM fi.posttrade_commands WHERE sandbox_id=$1) commands,
   (SELECT count(*)::int FROM fi.posttrade_events WHERE sandbox_id=$1) events,b.command_count pc,b.event_count pe,
   b.cash_cents::text cash,(SELECT sum(available_par)::text FROM fi.posttrade_security_balances WHERE sandbox_id=$1) par,
   (SELECT sum(economic_cash_cents)::text FROM fi.posttrade_events WHERE sandbox_id=$1) econ_cash,
   (SELECT sum(economic_par_amount)::text FROM fi.posttrade_events WHERE sandbox_id=$1) econ_par
   FROM fi.posttrade_books b WHERE sandbox_id=$1`,
        [s.id],
      )
    ).rows[0]!;
    const legacy = (
      await admin.query<{ n: number }>('SELECT command_count n FROM fi.sandboxes WHERE id=$1', [
        s.id,
      ])
    ).rows[0]!.n;
    assert.equal(legacy, 415);
    assert.equal(legacy + counts.pc, 512);
    assert.equal(counts.commands, 97);
    assert.equal(counts.events, 161);
    assert.equal(counts.pc, 97);
    assert.equal(counts.pe, 161);
    assert.equal(counts.cash, '10000000000');
    assert.equal(Number(counts.par), 0);
    assert.equal(BigInt(counts.econ_cash), 0n);
    assert.equal(Number(counts.econ_par), 0);
    const cost = (
      await admin.query<{ operation: string; n: number; e: number }>(
        `SELECT c.operation,count(DISTINCT c.id)::int n,count(e.*)::int e FROM fi.posttrade_commands c
   JOIN fi.posttrade_events e USING(sandbox_id,command_seq) WHERE c.sandbox_id=$1 GROUP BY c.operation ORDER BY c.operation`,
        [s.id],
      )
    ).rows;
    assert.deepEqual(cost, [
      { operation: 'BUST', n: 8, e: 8 },
      { operation: 'CORRECT_PRICE', n: 16, e: 32 },
      { operation: 'INITIALIZE', n: 1, e: 1 },
      { operation: 'REGISTER', n: 8, e: 8 },
      { operation: 'REVERSE', n: 24, e: 48 },
      { operation: 'SETTLE', n: 40, e: 64 },
    ]);
    for (const receipt of receipts) {
      const replay = await s.post(receipt.op, receipt.payload, receipt.key);
      assert.equal(replay.status, receipt.status);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.body, receipt.body);
    }
    assert.equal((await s.command('ACK_ORDER', { expected_version: '999' })).status, 429);
    assert.deepEqual(await legacySnapshot(), legacyBefore);
    const source = await s.read();
    assert.equal(source.posttrade_command_seq, '97');
    assert.equal(source.coverage.complete, true);
    assert.ok(
      source.roots.every(
        (root) => root.busted && root.current_revision === 2 && root.settlement_state === 'VOIDED',
      ),
    );
    assert.equal(Number(available(source)), 0);
    assert.equal(source.available_cash_cents, '10000000000');
    assert.deepEqual(
      (
        await admin.query<{ raw: unknown }>(
          'SELECT jsonb_agg(to_jsonb(x) ORDER BY id) raw FROM fi.executions x WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.raw,
      original,
    );
  } finally {
    await admin.end();
    await s.close();
  }
});
